// hardware/firmware/onboard-led-test/onboard-led-test.ino
// 【板载灯测试版】ESP32-C6 SuperMini —— 只用板载 WS2812 RGB 灯（GPIO8）测试整条链路。
// 不接任何外部 LED，先验证「PC 软件 → 串口 → ESP32 → 灯变色」是否全通。
//
// 与正式的 agent-leds.ino 用【同一套串口协议】（见 hardware/PROTOCOL.md）：
//     R,G,B;R,G,B;R,G,B;R,G,B\n
// 但板载只有 1 颗灯，所以只取第 1 组 RGB（= 最活跃的 agent，LED0）显示，其余 3 组忽略。
// 这样 PC 端软件一行都不用改；将来换成 4 颗外部灯直接烧 agent-leds.ino 即可。
//
// 依赖：ESP32 Arduino Core 3.0.0+（内置 rgbLedWrite，无需任何库）。
// 烧录前务必：Tools ▸ USB CDC On Boot ▸ Enabled（否则串口收不到数据）。

#define RGB_LED_PIN 8    // 板载 WS2812 在 GPIO8（C6 SuperMini）

// 全局亮度缩放（0..255）。WS2812 很亮，调低护眼；协议里的数值已偏低，这里再留个总闸。
const int BRIGHTNESS = 40;

String buf = "";
int curR = 0, curG = 0, curB = 0;

void applyColor(int r, int g, int b) {
  curR = r; curG = g; curB = b;
  // rgbLedWrite 按标准 R,G,B 传入，核心内部处理 WS2812 的 GRB 时序。
  rgbLedWrite(RGB_LED_PIN,
              (r * BRIGHTNESS) / 255,
              (g * BRIGHTNESS) / 255,
              (b * BRIGHTNESS) / 255);
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

  applyColor(r, g, b);
}

bool selfTestDone = false;

void setup() {
  Serial.begin(115200);
  // C6 原生 USB-CDC：上电给主机一点时间稳定枚举，避免端口刚上电就忙、反复重连。
  delay(500);
  applyColor(0, 0, 0);           // 上电先灭
  Serial.println("READY");       // 仅调试；PC 桥忽略
}

// 上电自检移到 loop 首次执行：红→绿→蓝各闪一下，确认板载灯好使、颜色顺序对。
// 放这里而非 setup，避免 setup 里长时间 delay 干扰 USB-CDC 枚举。
void runSelfTest() {
  applyColor(255, 0, 0); delay(300);
  applyColor(0, 255, 0); delay(300);
  applyColor(0, 0, 255); delay(300);
  applyColor(0, 0, 0);
}

void loop() {
  if (!selfTestDone) { runSelfTest(); selfTestDone = true; }

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
