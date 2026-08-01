// hardware/firmware/agent-leds/agent-leds.ino
// ESP32-C6 SuperMini —— 4 颗独立 RGB LED 显示 Claude agent 状态。
// 从 USB 串口读 PC 桥（serial-bridge.js）按 PROTOCOL.md 发来的帧：
//     R,G,B;R,G,B;R,G,B;R,G,B\n
// 解析成 4×3 路 PWM 输出到 12 个 GPIO。
//
// 硬件假设：共阴 RGB LED（公共脚接 GND，3 个色脚各串限流电阻接 GPIO）。
// 若你用的是共阳（公共脚接 3V3），把下面 COMMON_ANODE 改成 true。
//
// 波特率 115200，与 PROTOCOL.md 一致。

// ── 是否共阳 ──────────────────────────────────────────
#define COMMON_ANODE false   // 共阴=false；共阳=true（PWM 取反）

// ── 引脚表：4 颗 LED × {R,G,B} = 12 个 GPIO ─────────────
// ESP32-C6 SuperMini 可用 GPIO，已避开 strapping(GPIO8/9/15) 与 USB(GPIO12/13)。
// 若与你的实际接线不同，改这里即可。顺序：{R, G, B}
const int LED_PINS[4][3] = {
  { 0,  1,  2},   // LED0（最活跃的 agent）
  { 3,  4,  5},   // LED1
  { 6,  7, 10},   // LED2
  {18, 19, 20},   // LED3
};

const int NUM_LEDS = 4;
const int PWM_FREQ = 5000;    // 5kHz，肉眼无闪
const int PWM_RES  = 8;       // 8 位分辨率 → 0..255，与协议分量一致

// 全局亮度缩放（0..255）。协议里的数值已偏低，这里再留一个总闸。
const int BRIGHTNESS = 255;

// 收帧缓冲
String buf = "";

// 当前各 LED 的 RGB（用于串口静默时保持上一帧）
int cur[4][3] = {{0,0,0},{0,0,0},{0,0,0},{0,0,0}};

void writeChannel(int pin, int value) {
  int v = (value * BRIGHTNESS) / 255;
  if (COMMON_ANODE) v = 255 - v;   // 共阳：高电平灭，需取反
  ledcWrite(pin, v);
}

void applyLed(int i, int r, int g, int b) {
  cur[i][0] = r; cur[i][1] = g; cur[i][2] = b;
  writeChannel(LED_PINS[i][0], r);
  writeChannel(LED_PINS[i][1], g);
  writeChannel(LED_PINS[i][2], b);
}

// 解析一整帧："R,G,B;R,G,B;R,G,B;R,G,B"
// 成功且恰好 4 组、每组 3 个 0..255 分量才应用；否则整帧丢弃（保持上一帧）。
void parseFrame(const String &line) {
  int rgb[4][3];
  int group = 0;
  int start = 0;
  while (group < NUM_LEDS) {
    int semi = line.indexOf(';', start);
    String part = (semi < 0) ? line.substring(start) : line.substring(start, semi);
    part.trim();

    int c1 = part.indexOf(',');
    int c2 = part.indexOf(',', c1 + 1);
    if (c1 < 0 || c2 < 0) return;  // 组内不足 3 分量 → 畸形，丢弃

    long r = part.substring(0, c1).toInt();
    long g = part.substring(c1 + 1, c2).toInt();
    long b = part.substring(c2 + 1).toInt();
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return; // 越界 → 丢弃

    rgb[group][0] = r; rgb[group][1] = g; rgb[group][2] = b;
    group++;

    if (semi < 0) break;
    start = semi + 1;
  }
  if (group != NUM_LEDS) return;   // 组数不对 → 丢弃

  for (int i = 0; i < NUM_LEDS; i++) applyLed(i, rgb[i][0], rgb[i][1], rgb[i][2]);
}

void setup() {
  Serial.begin(115200);
  // 每路 PWM 通道：新版 ESP32 core 用 ledcAttach(pin, freq, res)，通道自动分配。
  for (int i = 0; i < NUM_LEDS; i++) {
    for (int c = 0; c < 3; c++) {
      ledcAttach(LED_PINS[i][c], PWM_FREQ, PWM_RES);
    }
  }
  // 上电全灭
  for (int i = 0; i < NUM_LEDS; i++) applyLed(i, 0, 0, 0);
  Serial.println("READY");   // 仅调试，PC 桥忽略
}

void loop() {
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
}
