// hardware/firmware/meter-sweep-test/meter-sweep-test.ino
// 表头单机测试：上电后两个 DAC 指针表头【无限来回摆】，不收串口、不管灯。
// 专门用来查表头——看指针是否活着、行程是否够、哪一侧不动、方向对不对。
//
// 硬件：CPU_SHOW 那块初代 ESP32，两路 DAC 直驱指针表头（沿用原固件接线）：
//   左表 = GPIO26 (DAC2)，右表 = GPIO25 (DAC1)。
// 上传后：两个指针一起从静止端→满偏→静止端，不停来回，慢速便于肉眼跟。
//
// 用法：Arduino IDE 选 "ESP32 Dev Module"，Upload Speed 115200，选 COM10，上传。
// 串口监视器 115200 会打印当前 DAC 值，方便对照指针位置。
// 测完换回 cpushow-agent-leds.ino 即可。

const int METER_PINS[2] = { 26, 25 };   // 左表 DAC2, 右表 DAC1
const int METER_MIN = 10;               // 指针静止端
const int METER_MAX = 170;              // 指针满偏端
const int STEP      = 2;                // 每步 DAC 变化量（越小越慢越平滑）
const int STEP_MS   = 20;               // 每步间隔 ms

void setup() {
  Serial.begin(115200);
  // DAC 直驱无需 attach，dacWrite 即用。开机先都摆到静止端。
  for (int i = 0; i < 2; i++) dacWrite(METER_PINS[i], METER_MIN);
  Serial.println("METER SWEEP TEST: 两表指针将无限来回摆动");
}

// 两个表同时、同向写同一个 DAC 值：只验证指针本身活不活、行程够不够。
// 若某一侧纹丝不动 → 那一侧引脚/表/焊点问题（与另一侧代码完全相同，可直接对比）。
void loop() {
  for (int v = METER_MIN; v <= METER_MAX; v += STEP) {
    for (int i = 0; i < 2; i++) dacWrite(METER_PINS[i], v);
    Serial.println(v);
    delay(STEP_MS);
  }
  for (int v = METER_MAX; v >= METER_MIN; v -= STEP) {
    for (int i = 0; i < 2; i++) dacWrite(METER_PINS[i], v);
    Serial.println(v);
    delay(STEP_MS);
  }
}
