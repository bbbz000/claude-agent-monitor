// hardware/firmware/cpushow-agent-leds/cpushow-agent-leds.ino
// CPU_SHOW 硬件（初代 ESP32 + CH9102 + 左右两组共阴 RGB LED）—— 显示 Claude agent 状态。
//
// 本固件复刻自同目录 agent-leds/（ESP32-C6 版），针对 CPU_SHOW 这块板做了三处适配：
//   1. 芯片是【初代 ESP32】（有 DAC，故 CPU_SHOW 用它驱动指针表头）。本固件按
//      ESP32 Arduino Core 3.x 的 LEDC 新 API 写：ledcAttach(pin,freq,res) + ledcWrite(pin,val)，
//      直接按引脚操作、无需手动分配通道（旧 2.x 的 ledcSetup/ledcAttachPin 在 3.x 已移除）。
//   2. 引脚沿用 CPU_SHOW 原固件的接线：左灯 R/G/B = GPIO5/18/19，右灯 = GPIO13/12/14；
//      两个指针表头由 DAC 直驱：左表 GPIO26(DAC2)、右表 GPIO25(DAC1)。
//   3. 没有板载 WS2812，去掉 C6 版的 rgbLedWrite() 探针。
//
// 数据来源：PC 端（小条主进程 / serial-bridge.js）按 hardware/PROTOCOL.md 发来一帧
//     R,G,B;R,G,B;R,G,B;R,G,B|A0,A1,A2,A3\n
//   分号段 = 各槽状态颜色；管道段 A = 各槽活跃度 0..255（越活跃越大）。
// 本板只有 2 组显示：agent1→左灯+左表(LED0)，agent2→右灯+右表(LED1)，其余组忽略。
//   · 灯：颜色显示状态（WORKING/WAITING/RECENT/空），见下方动效。
//   · 表：指针显示活跃度（连续量），平滑扫动。
//
// 硬件假设：共阴 RGB LED（公共脚接 GND，3 个色脚各串限流电阻接 GPIO）。
// 共阳（公共脚接 3V3）把 COMMON_ANODE 改成 true。
//
// 【动效】按收到的 RGB 反推状态加动效（PC 端只发静态颜色，颜色即唯一可辨状态）：
//   WORKING(绿 0,200,0)→呼吸  WAITING(橙 255,80,0)→快闪  RECENT(黄)/其它→常亮  DONE/空→灭
//
// 【看门狗】超过 WATCHDOG_MS 没收到任何帧 → 全灭，保护灯寿命、兜异常退出/拔线/死机。
//
// 依赖：ESP32 Arduino Core 3.0.0+（初代 ESP32，Boards Manager 装 "esp32" 选 "ESP32 Dev Module"）。
// 初代 ESP32 走外置 CH9102 USB 串口，【无需】开 USB CDC On Boot。波特率 115200，与 PC 端统一。

// ── 是否共阳 ──────────────────────────────────────────
#define COMMON_ANODE false   // 共阴=false；共阳=true（PWM 取反）

// ── 调试：外接 LED 常亮 ────────────────────────────────
// true = 上电后两颗灯直接白光常亮不灭，不收串口/不动效。纯测硬件通路用。
// 测完改回 false 恢复正常。
#define DEBUG_FORCE_ON false

// ── 引脚表：NUM_SLOTS 颗 LED × {R,G,B} ─────────────────
// 顺序 {R, G, B}，沿用 CPU_SHOW 原固件接线。未接的槽整行填 {-1,-1,-1} → 该槽禁用。
const int NUM_SLOTS = 2;
const int LED_PINS[NUM_SLOTS][3] = {
  { 5, 18, 19},   // LED0 = 左灯（agent1，最活跃）
  {13, 12, 14},   // LED1 = 右灯（agent2）
};

const int PWM_FREQ = 5000;    // 5kHz，肉眼无闪
const int PWM_RES  = 8;       // 8 位 → 0..255，与协议分量一致
const int BRIGHTNESS = 255;   // 全局亮度总闸（0..255）

// ── 指针表头（DAC）：显示各槽“活跃度” ─────────────────
// CPU_SHOW 这块板有两个模拟指针表头，由初代 ESP32 的两路 DAC 直驱（沿用原固件接线）：
//   左表 = GPIO26(DAC2) = agent1 活跃度；右表 = GPIO25(DAC1) = agent2 活跃度。
// 活跃度来自 PC 端帧尾的 |A0,A1,... 段（0..255，越活跃越大，见 PROTOCOL.md）。
const int METER_PINS[NUM_SLOTS] = { 26, 25 };   // 左表 DAC2, 右表 DAC1
// 指针物理行程对应的 DAC 8bit 值域（沿用原 CPU_SHOW 固件的 10..170）。
const int METER_MIN = 10;     // 指针静止端
const int METER_MAX = 170;    // 指针满偏端
// 指针平滑：每帧(~16ms)朝目标挪的最大步长，避免跳变（原固件 loopTask2 的渐进手感）。
const int METER_STEP = 3;
// 各表是否反装：true = 活跃时指针走向 MIN 端而非 MAX 端。
// 默认按原 CPU_SHOW 固件：左表反装、右表正装。自检时若某表方向反了，翻这里对应项即可。
const bool METER_REVERSE[NUM_SLOTS] = { true, false };

// 看门狗：3 分钟没收到任何帧就全灭
const unsigned long WATCHDOG_MS = 3UL * 60UL * 1000UL;
// 动效节奏
const unsigned long BREATH_PERIOD_MS = 2600;
const unsigned long BLINK_PERIOD_MS  = 320;

enum Effect { EFF_OFF, EFF_BREATHE, EFF_BLINK, EFF_SOLID };

String buf = "";
int   cur[NUM_SLOTS][3];              // 各槽目标 RGB（未经动效缩放）
Effect eff[NUM_SLOTS];               // 各槽当前动效
int   curAct[NUM_SLOTS];             // 各槽目标活跃度 0..255（来自帧尾 | 段）
int   dacCur[NUM_SLOTS];             // 各表当前 DAC 输出值（平滑逼近用，非目标）
unsigned long lastFrameMs = 0;
bool everReceived = false;

// 活跃度(0..255) → 该表的目标 DAC 值(METER_MIN..METER_MAX)，含反装处理。
int meterTargetFor(int i) {
  long span = METER_MAX - METER_MIN;
  int scaled = METER_MIN + (int)((long)curAct[i] * span / 255);   // 活跃→MAX
  if (METER_REVERSE[i]) scaled = METER_MIN + METER_MAX - scaled;  // 反装→活跃走 MIN
  return scaled;
}

// 槽是否启用（引脚有效）。R 脚 >=0 即视为启用（三脚要么都填要么都 -1）。
inline bool slotEnabled(int i) { return LED_PINS[i][0] >= 0; }

// 写单路 PWM（含亮度缩放 + 共阳取反 + 额外动态缩放 scale 0..255）。
// Core 3.x：ledcWrite 直接按【引脚号】写。
void writeChannel(int slot, int color, int value, int scale) {
  int pin = LED_PINS[slot][color];
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

// 解析一整帧：PC 端固定发 4 组，本板只取前 NUM_SLOTS(=2) 组，多余组读完即丢。
// 每组必须是 3 个 0..255，否则整帧丢弃（保持上一帧，不闪）。
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
  if (group != NUM_SLOTS) return;   // 前 2 组没凑齐 → 丢弃

  for (int i = 0; i < NUM_SLOTS; i++) {
    cur[i][0] = rgb[i][0]; cur[i][1] = rgb[i][1]; cur[i][2] = rgb[i][2];
    eff[i] = effectForColor(rgb[i][0], rgb[i][1], rgb[i][2]);
  }

  // 活跃度段：帧尾 "...|A0,A1,A2,A3"（在全部分号组之后）。本板只取前 NUM_SLOTS 个。
  // 【关键】上面的 while 只读满 NUM_SLOTS 组就 break，永远够不到 | 段，故这里对整行单独找 |。
  // 缺 | 段（旧 PC 端）或值不足 → 对应槽活跃度按 0 处理，指针落回静止端，不影响已解析的 RGB。
  int act[NUM_SLOTS];
  for (int i = 0; i < NUM_SLOTS; i++) act[i] = 0;
  int bar = line.indexOf('|');
  if (bar >= 0) {
    int p = bar + 1;
    for (int i = 0; i < NUM_SLOTS; i++) {
      int comma = line.indexOf(',', p);
      String tok = (comma < 0) ? line.substring(p) : line.substring(p, comma);
      tok.trim();
      long a = tok.toInt();
      act[i] = a < 0 ? 0 : (a > 255 ? 255 : a);
      if (comma < 0) break;      // 值比槽少：剩余槽保持 0
      p = comma + 1;
    }
  }
  for (int i = 0; i < NUM_SLOTS; i++) curAct[i] = act[i];

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
  writeChannel(i, 0, cur[i][0], scale);
  writeChannel(i, 1, cur[i][1], scale);
  writeChannel(i, 2, cur[i][2], scale);
}

// 平滑驱动所有指针表头：dacCur[] 每帧朝各自目标挪最多 METER_STEP，再写 DAC。非阻塞。
void renderMeters() {
  for (int i = 0; i < NUM_SLOTS; i++) {
    int target = meterTargetFor(i);
    if (dacCur[i] < target)      dacCur[i] = min(target, dacCur[i] + METER_STEP);
    else if (dacCur[i] > target) dacCur[i] = max(target, dacCur[i] - METER_STEP);
    dacWrite(METER_PINS[i], dacCur[i]);
  }
}

bool selfTestDone = false;

// 上电自检：逐颗启用的灯，红→绿→蓝各亮 1 秒再灭。用于肉眼确认哪颗灯活着、R/G/B 接得对不对。
void runSelfTest() {
  const int seq[3][3] = { {255,0,0}, {0,255,0}, {0,0,255} }; // 红、绿、蓝
  for (int i = 0; i < NUM_SLOTS; i++) {
    if (!slotEnabled(i)) continue;
    for (int s = 0; s < 3; s++) {
      writeChannel(i, 0, seq[s][0], 255);
      writeChannel(i, 1, seq[s][1], 255);
      writeChannel(i, 2, seq[s][2], 255);
      delay(1000);
    }
    // 该颗灭，进入下一颗
    writeChannel(i, 0, 0, 0);
    writeChannel(i, 1, 0, 0);
    writeChannel(i, 2, 0, 0);
    delay(300);
  }
  // 表头自检：两表指针一起 静止端→满偏→静止端 扫一遍，肉眼确认指针活着、行程对。
  for (int v = METER_MIN; v <= METER_MAX; v += 4) {
    for (int i = 0; i < NUM_SLOTS; i++) dacWrite(METER_PINS[i], v);
    delay(12);
  }
  for (int v = METER_MAX; v >= METER_MIN; v -= 4) {
    for (int i = 0; i < NUM_SLOTS; i++) dacWrite(METER_PINS[i], v);
    delay(12);
  }
  for (int i = 0; i < NUM_SLOTS; i++) dacCur[i] = METER_MIN;  // 与静止端对齐，避免入 loop 后跳变
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < NUM_SLOTS; i++) {
    cur[i][0] = cur[i][1] = cur[i][2] = 0;
    eff[i] = EFF_OFF;
    // 表头初始：目标活跃度 0、指针在静止端。DAC 直驱无需 attach，dacWrite 即用。
    curAct[i] = 0;
    dacCur[i] = METER_MIN;
    dacWrite(METER_PINS[i], METER_MIN);
    if (!slotEnabled(i)) continue;
    // Core 3.x：直接把每个引脚 attach 成 PWM 输出（含频率与分辨率）。
    for (int c = 0; c < 3; c++) {
      ledcAttach(LED_PINS[i][c], PWM_FREQ, PWM_RES);
    }
    // 上电全灭
    writeChannel(i, 0, 0, 0);
    writeChannel(i, 1, 0, 0);
    writeChannel(i, 2, 0, 0);
  }
  Serial.println("READY");   // 仅调试，PC 端忽略
}

void loop() {
  // 调试常亮：两颗灯白光全开常亮，跳过串口/动效。纯测硬件通路。
  if (DEBUG_FORCE_ON) {
    for (int i = 0; i < NUM_SLOTS; i++) {
      if (slotEnabled(i)) {
        writeChannel(i, 0, 255, 255);
        writeChannel(i, 1, 255, 255);
        writeChannel(i, 2, 255, 255);
      }
      dacWrite(METER_PINS[i], METER_MAX);  // 指针打满，测行程
    }
    delay(50);
    return;
  }

  // 上电自检（首次进 loop 执行一次）。初代 ESP32 走外置串口，自检的阻塞 delay 不影响枚举，
  // 但沿用 C6 版放 loop 的做法，保持两版结构一致、便于对照维护。
  if (!selfTestDone) { runSelfTest(); selfTestDone = true; lastFrameMs = millis(); }

  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n') { parseFrame(buf); buf = ""; }
    else if (ch != '\r') {
      buf += ch;
      if (buf.length() > 128) buf = "";  // 防溢出
    }
  }

  // 看门狗：收过帧且超时未再收到 → 全灭，表头也回落到静止端
  if (everReceived && (millis() - lastFrameMs > WATCHDOG_MS)) {
    for (int i = 0; i < NUM_SLOTS; i++) {
      eff[i] = EFF_OFF; cur[i][0]=cur[i][1]=cur[i][2]=0;
      curAct[i] = 0;   // 目标活跃度归零 → renderMeters 平滑把指针带回 MIN
    }
  }

  unsigned long now = millis();
  for (int i = 0; i < NUM_SLOTS; i++) renderSlot(i, now);
  renderMeters();
  delay(16);  // ~60fps
}
