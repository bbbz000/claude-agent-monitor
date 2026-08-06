// hardware/firmware/agent-leds/agent-leds.ino
// ESP32-C6 SuperMini —— 独立 RGB LED 显示 Claude agent 状态。
// 从 USB 串口读 PC 端（小条主进程 / serial-bridge.js）按 PROTOCOL.md 发来的帧：
//     R,G,B;R,G,B;R,G,B;R,G,B\n   （4 组，最活跃的 agent 在第 1 组）
// 解析成每颗 LED 的 3 路 PWM 输出。
//
// 硬件假设：共阴 RGB LED（公共脚接 GND，3 个色脚各串限流电阻接 GPIO）。
// 共阳（公共脚接 3V3）把 COMMON_ANODE 改成 true。
//
// 【灯数与禁用】固件按 NUM_SLOTS=4 槽配置（对齐 PC 端 LED_COUNT=4 的帧）。
// 没接灯的槽把 3 个引脚都填 -1 → 固件跳过它（不 attach、不输出）。想加灯就填回真实引脚号。
//
// 【动效】按收到的 RGB 反推状态加动效（与板载测试版一致，PC 端只发静态颜色）：
//   WORKING(绿 0,200,0)→呼吸  WAITING(橙 255,80,0)→快闪  RECENT(黄)/其它→常亮  DONE/空→灭
//
// 【看门狗】超过 WATCHDOG_MS 没收到任何帧 → 全灭，保护灯寿命、兜异常退出/拔线/死机。
//
// 依赖：ESP32 Arduino Core 3.0.0+（ledcAttach）。烧录前开 Tools ▸ USB CDC On Boot ▸ Enabled。

// ── 是否共阳 ──────────────────────────────────────────
#define COMMON_ANODE false   // 共阴=false；共阳=true（PWM 取反）

// ── 调试：外接 LED 常亮 ────────────────────────────────
// true = 上电后所有启用的槽直接白光常亮不灭，不收串口/不动效。纯测硬件通路用。
// 测完改回 false 恢复正常。
#define DEBUG_FORCE_ON false

// ── 引脚表：NUM_SLOTS 颗 LED × {R,G,B} ─────────────────
// 顺序 {R, G, B}。未接的槽整行填 {-1,-1,-1} → 该槽禁用。
// 已避开 strapping(GP8/9/15)、板载 WS2812(GP8)、BOOT(GP9)、USB(GP12/13) 与可能未引出的 GP14。
const int NUM_SLOTS = 4;
const int LED_PINS[NUM_SLOTS][3] = {
  { 5,  6,  7},   // LED0（最活跃的 agent）—— 已接
  { 0,  1,  2},   // LED1 —— 已接
  {-1, -1, -1},   // LED2 —— 未接（禁用）
  {-1, -1, -1},   // LED3 —— 未接（禁用）
};

const int PWM_FREQ = 5000;    // 5kHz，肉眼无闪
const int PWM_RES  = 8;       // 8 位 → 0..255，与协议分量一致
const int BRIGHTNESS = 255;   // 全局亮度总闸（0..255）

// 看门狗：3 分钟没收到任何帧就全灭
const unsigned long WATCHDOG_MS = 3UL * 60UL * 1000UL;
// 动效节奏
const unsigned long BREATH_PERIOD_MS = 2600;
const unsigned long BLINK_PERIOD_MS  = 320;

enum Effect { EFF_OFF, EFF_BREATHE, EFF_BLINK, EFF_SOLID };

String buf = "";
int   cur[NUM_SLOTS][3];              // 各槽目标 RGB（未经动效缩放）
Effect eff[NUM_SLOTS];               // 各槽当前动效
unsigned long lastFrameMs = 0;
bool everReceived = false;

// 槽是否启用（引脚有效）。R 脚 >=0 即视为启用（三脚要么都填要么都 -1）。
inline bool slotEnabled(int i) { return LED_PINS[i][0] >= 0; }

// 写单路 PWM（含亮度缩放 + 共阳取反 + 额外动态缩放 scale 0..255）。pin<0 跳过。
void writeChannel(int pin, int value, int scale) {
  if (pin < 0) return;
  long v = (long)value * BRIGHTNESS / 255 * scale / 255;
  if (COMMON_ANODE) v = 255 - v;
  ledcWrite(pin, v);
}

// 由颜色反推状态 → 动效（颜色是 led-frame.js 固定映射，唯一可辨）。
Effect effectForColor(int r, int g, int b) {
  if (r == 0 && g == 0 && b == 0)     return EFF_OFF;      // 灭 / DONE
  if (r == 0 && g == 200 && b == 0)   return EFF_BREATHE;  // WORKING 绿 → 呼吸
  if (r == 255 && g == 80 && b == 0)  return EFF_BLINK;    // WAITING 橙 → 快闪
  return EFF_SOLID;                                         // RECENT 黄 / 其它 → 常亮
}

// 解析一整帧，恰好 NUM_SLOTS 组、每组 3 个 0..255 才应用；否则整帧丢弃（保持上一帧）。
void parseFrame(const String &line) {
  int rgb[NUM_SLOTS][3];
  int group = 0, start = 0;
  while (group < NUM_SLOTS) {
    int semi = line.indexOf(';', start);
    String part = (semi < 0) ? line.substring(start) : line.substring(start, semi);
    part.trim();
    int c1 = part.indexOf(',');
    int c2 = part.indexOf(',', c1 + 1);
    if (c1 < 0 || c2 < 0) return;
    long r = part.substring(0, c1).toInt();
    long g = part.substring(c1 + 1, c2).toInt();
    long b = part.substring(c2 + 1).toInt();
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return;
    rgb[group][0] = r; rgb[group][1] = g; rgb[group][2] = b;
    group++;
    if (semi < 0) break;
    start = semi + 1;
  }
  if (group != NUM_SLOTS) return;   // 组数不对 → 丢弃

  for (int i = 0; i < NUM_SLOTS; i++) {
    cur[i][0] = rgb[i][0]; cur[i][1] = rgb[i][1]; cur[i][2] = rgb[i][2];
    eff[i] = effectForColor(rgb[i][0], rgb[i][1], rgb[i][2]);
  }
  lastFrameMs = millis();
  everReceived = true;
}

// 把某槽按其动效画出来（非阻塞，靠 millis 算相位）。
void renderSlot(int i, unsigned long now) {
  if (!slotEnabled(i)) return;
  int scale = 255;
  switch (eff[i]) {
    case EFF_OFF:   scale = 0; break;
    case EFF_SOLID: scale = 255; break;
    case EFF_BREATHE: {
      float ph = (now % BREATH_PERIOD_MS) / (float)BREATH_PERIOD_MS;
      float s = (1.0f - cosf(ph * 2.0f * PI)) * 0.5f;   // 0..1
      scale = 30 + (int)(s * 225);                       // 30..255 留底光
      break;
    }
    case EFF_BLINK: {
      bool on = (now % BLINK_PERIOD_MS) < (BLINK_PERIOD_MS / 2);
      scale = on ? 255 : 0;
      break;
    }
  }
  writeChannel(LED_PINS[i][0], cur[i][0], scale);
  writeChannel(LED_PINS[i][1], cur[i][1], scale);
  writeChannel(LED_PINS[i][2], cur[i][2], scale);
}

bool selfTestDone = false;

// 上电自检：逐颗启用的灯，红→绿→蓝各亮 1 秒再灭。用于肉眼确认哪颗灯活着、R/G/B 接得对不对。
// 放 loop 首次执行（不在 setup）：自检有 ~6.6s 阻塞 delay，放 setup 会卡住 C6 的 USB-CDC 枚举。
void runSelfTest() {
  const int seq[3][3] = { {255,0,0}, {0,255,0}, {0,0,255} }; // 红、绿、蓝
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (!slotEnabled(i)) continue;
    for (int s = 0; s < 3; s++) {
      writeChannel(LED_PINS[i][0], seq[s][0], 255);
      writeChannel(LED_PINS[i][1], seq[s][1], 255);
      writeChannel(LED_PINS[i][2], seq[s][2], 255);
      delay(1000);
    }
    // 该颗灭，进入下一颗
    writeChannel(LED_PINS[i][0], 0, 0);
    writeChannel(LED_PINS[i][1], 0, 0);
    writeChannel(LED_PINS[i][2], 0, 0);
    delay(300);
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);                // C6 原生 USB-CDC：给主机一点枚举时间，避免上电即忙、反复重连
  for (int i = 0; i < NUM_SLOTS; i++) {
    cur[i][0] = cur[i][1] = cur[i][2] = 0;
    eff[i] = EFF_OFF;
    if (!slotEnabled(i)) continue;
    for (int c = 0; c < 3; c++) ledcAttach(LED_PINS[i][c], PWM_FREQ, PWM_RES);
    // 上电全灭
    writeChannel(LED_PINS[i][0], 0, 0);
    writeChannel(LED_PINS[i][1], 0, 0);
    writeChannel(LED_PINS[i][2], 0, 0);
  }
  Serial.println("READY");   // 仅调试，PC 端忽略
}

void loop() {
  // 板载探针：上电先闪板载 WS2812(GPIO8) 红绿蓝一次，证明"这版固件跑起来了"。
  // 放在最前、常亮分支之前，无论 DEBUG_FORCE_ON 与否都会执行。
  static bool probeDone = false;
  if (!probeDone) {
    rgbLedWrite(8, 60, 0, 0); delay(500);
    rgbLedWrite(8, 0, 60, 0); delay(500);
    rgbLedWrite(8, 0, 0, 60); delay(500);
    rgbLedWrite(8, 0, 0, 0);  delay(300);
    probeDone = true;
  }

  // 调试常亮：所有启用的槽白光全开常亮，跳过串口/动效。纯测硬件通路。
  if (DEBUG_FORCE_ON) {
    for (int i = 0; i < NUM_SLOTS; i++) {
      if (!slotEnabled(i)) continue;
      writeChannel(LED_PINS[i][0], 255, 255);
      writeChannel(LED_PINS[i][1], 255, 255);
      writeChannel(LED_PINS[i][2], 255, 255);
    }
    delay(50);
    return;
  }

  // 上电自检放这里而非 setup：自检有 ~6.6s 阻塞 delay，放 setup 会卡住 C6 的 USB-CDC 枚举。
  if (!selfTestDone) { runSelfTest(); selfTestDone = true; lastFrameMs = millis(); }

  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n') { parseFrame(buf); buf = ""; }
    else if (ch != '\r') {
      buf += ch;
      if (buf.length() > 128) buf = "";  // 防溢出
    }
  }

  // 看门狗：收过帧且超时未再收到 → 全灭
  if (everReceived && (millis() - lastFrameMs > WATCHDOG_MS)) {
    for (int i = 0; i < NUM_SLOTS; i++) { eff[i] = EFF_OFF; cur[i][0]=cur[i][1]=cur[i][2]=0; }
  }

  unsigned long now = millis();
  for (int i = 0; i < NUM_SLOTS; i++) renderSlot(i, now);
  delay(16);  // ~60fps
}
