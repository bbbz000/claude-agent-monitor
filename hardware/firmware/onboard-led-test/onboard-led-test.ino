// hardware/firmware/onboard-led-test/onboard-led-test.ino
// 【板载灯测试版】ESP32-C6 SuperMini —— 只用板载 WS2812 RGB 灯（GPIO8）显示 agent 状态。
// 不接任何外部 LED，验证「PC 软件 → 串口 → ESP32 → 灯」整条链路。
//
// 与正式的 agent-leds.ino 用【同一套串口协议】（见 hardware/PROTOCOL.md）：
//     R,G,B;R,G,B;R,G,B;R,G,B\n
// 板载只有 1 颗灯，只取第 1 组 RGB（= 最活跃的 agent，LED0）显示，其余 3 组忽略。
// PC 端软件一行都不用改。
//
// 【动效】固件按收到的 RGB 反推状态，加动态效果（PC 端只发静态颜色，动效在设备侧算）：
//   - WORKING(绿 0,200,0)   → 呼吸（亮度正弦渐变）
//   - WAITING(橙 255,80,0)  → 快闪（快速闪烁，催你去处理）
//   - RECENT(黄 200,160,0)  → 常亮
//   - DONE/空(0,0,0)        → 灭
//   - 其它任意颜色          → 常亮（兜底，比如将来改了配色）
//
// 【看门狗】超过 WATCHDOG_MS 没收到任何串口帧 → 自动熄灭，保护灯寿命。
//   覆盖三种场景：PC 程序异常退出、拔线、PC 死机（正常退出时 PC 会主动发全灭帧）。
//   PC 端每 2 秒发一帧，正常运行绝不会误触发。
//
// 依赖：ESP32 Arduino Core 3.0.0+（内置 rgbLedWrite，无需任何库）。
// 烧录前务必：Tools ▸ USB CDC On Boot ▸ Enabled（否则串口收不到数据）。

#define RGB_LED_PIN 8    // 板载 WS2812 在 GPIO8（C6 SuperMini）

// 全局亮度缩放（0..255）。WS2812 很亮，调低护眼；协议里的数值已偏低，这里再留个总闸。
const int BRIGHTNESS = 40;

// 看门狗：3 分钟没收到任何帧就自动灭灯（保护灯寿命 + 兜住异常退出/拔线/死机）。
const unsigned long WATCHDOG_MS = 3UL * 60UL * 1000UL;

// 动效节奏
const unsigned long BREATH_PERIOD_MS = 2600; // 呼吸一个完整周期（暗→亮→暗）
const unsigned long BLINK_PERIOD_MS  = 320;  // 快闪一个完整周期（亮+灭）

// 当前状态（由收到的颜色反推），决定 loop 里画什么动效
enum Effect { EFF_OFF, EFF_BREATHE, EFF_BLINK, EFF_SOLID };

String buf = "";
int curR = 0, curG = 0, curB = 0;      // 最近一次收到的目标颜色（未经动效/亮度缩放）
Effect curEffect = EFF_OFF;
unsigned long lastFrameMs = 0;         // 最近一次收到合法帧的时刻（看门狗用）
bool everReceived = false;             // 是否收到过帧（没收到过时不启动看门狗，避免上电即灭）

// 直接把某颜色写到灯上（已含全局亮度缩放）。scale 0..255 再叠一层动态亮度。
void writeColor(int r, int g, int b, int scale = 255) {
  long rr = (long)r * BRIGHTNESS / 255 * scale / 255;
  long gg = (long)g * BRIGHTNESS / 255 * scale / 255;
  long bb = (long)b * BRIGHTNESS / 255 * scale / 255;
  // rgbLedWrite 按标准 R,G,B 传入，核心内部处理 WS2812 的 GRB 时序。
  rgbLedWrite(RGB_LED_PIN, rr, gg, bb);
}

// 由颜色反推状态 → 选动效。颜色是 led-frame.js 里固定映射，唯一可辨。
Effect effectForColor(int r, int g, int b) {
  if (r == 0 && g == 0 && b == 0)              return EFF_OFF;      // 灭 / DONE
  if (r == 0   && g == 200 && b == 0)          return EFF_BREATHE;  // WORKING 绿 → 呼吸
  if (r == 255 && g == 80  && b == 0)          return EFF_BLINK;    // WAITING 橙 → 快闪
  return EFF_SOLID;                                                  // RECENT 黄 / 其它 → 常亮
}

// 解析一整帧，只取第 1 组 "R,G,B"。成功且分量合法才应用；否则整帧丢弃（保持上一帧）。
void parseFrame(const String &line) {
  int semi = line.indexOf(';');                          // 第 1 组到第 1 个分号为止
  String first = (semi < 0) ? line : line.substring(0, semi);
  first.trim();

  int c1 = first.indexOf(',');
  int c2 = first.indexOf(',', c1 + 1);
  if (c1 < 0 || c2 < 0) return;                          // 不足 3 分量 → 畸形，丢弃

  long r = first.substring(0, c1).toInt();
  long g = first.substring(c1 + 1, c2).toInt();
  long b = first.substring(c2 + 1).toInt();
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return; // 越界 → 丢弃

  curR = r; curG = g; curB = b;
  curEffect = effectForColor(r, g, b);
  lastFrameMs = millis();       // 喂看门狗：任何合法帧都算“PC 还活着”
  everReceived = true;
}

bool selfTestDone = false;

void setup() {
  Serial.begin(115200);
  // C6 原生 USB-CDC：上电给主机一点时间稳定枚举，避免端口刚上电就忙、反复重连。
  delay(500);
  writeColor(0, 0, 0);           // 上电先灭
  Serial.println("READY");       // 仅调试；PC 桥忽略
}

// 上电自检移到 loop 首次执行：红→绿→蓝各闪一下，确认板载灯好使、颜色顺序对。
// 放这里而非 setup，避免 setup 里长时间 delay 干扰 USB-CDC 枚举。
void runSelfTest() {
  writeColor(255, 0, 0); delay(300);
  writeColor(0, 255, 0); delay(300);
  writeColor(0, 0, 255); delay(300);
  writeColor(0, 0, 0);
}

// 把动效画到灯上（每次 loop 调，非阻塞，靠 millis 算相位）。
void renderEffect() {
  unsigned long now = millis();
  switch (curEffect) {
    case EFF_OFF:
      writeColor(0, 0, 0);
      break;
    case EFF_SOLID:
      writeColor(curR, curG, curB);
      break;
    case EFF_BREATHE: {
      // 正弦呼吸：相位 0..2π 映射到亮度。留 12% 底光，避免全黑“断掉”的顿挫感。
      float ph = (now % BREATH_PERIOD_MS) / (float)BREATH_PERIOD_MS; // 0..1
      float s = (1.0f - cosf(ph * 2.0f * PI)) * 0.5f;                // 0..1 平滑起伏
      int scale = 30 + (int)(s * 225);                              // 30..255
      writeColor(curR, curG, curB, scale);
      break;
    }
    case EFF_BLINK: {
      // 快闪：半个周期亮、半个周期灭。橙色，催办。
      bool on = (now % BLINK_PERIOD_MS) < (BLINK_PERIOD_MS / 2);
      writeColor(curR, curG, curB, on ? 255 : 0);
      break;
    }
  }
}

void loop() {
  if (!selfTestDone) { runSelfTest(); selfTestDone = true; lastFrameMs = millis(); }

  // 读串口（非阻塞，逐字节攒帧）
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n') {
      parseFrame(buf);
      buf = "";
    } else if (ch != '\r') {
      buf += ch;
      if (buf.length() > 128) buf = "";  // 防溢出：异常长帧直接丢
    }
  }

  // 看门狗：收到过帧、且超时未再收到 → 强制灭灯（保护灯寿命，兜住异常退出/拔线/死机）
  if (everReceived && (millis() - lastFrameMs > WATCHDOG_MS)) {
    curEffect = EFF_OFF;
    curR = curG = curB = 0;
  }

  renderEffect();
  delay(16);  // ~60fps，够动效顺滑，又不占满 CPU
}
