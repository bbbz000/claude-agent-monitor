// hardware/led-frame.js
// 纯函数：把 scan() 的会话行数组 → 4 颗 RGB LED 的颜色 → 串口帧字符串。
// 零依赖，供【独立桥 serial-bridge.js】与【Electron 主进程】共用，避免两处各写一份映射。
// 帧格式与状态→RGB 映射的唯一真相源见 hardware/PROTOCOL.md。

export const LED_COUNT = 4; // 4 颗独立 RGB LED（物理上限）

// 状态 → RGB（见 PROTOCOL.md 的映射表）
export const EMPTY = [0, 0, 0]; // 灭（空槽 / 未知状态）

// 状态 → RGB（见 PROTOCOL.md 的映射表）
export const STATE_RGB = {
  WORKING: [0, 200, 0],     // 绿
  WAITING: [255, 80, 0],    // 橙
  DONE:    EMPTY,           // 灭：本轮已回复，不占灯（用户偏好）
  RECENT:  [200, 160, 0],   // 黄
};

// 全灭帧（退出/断开时发，避免灯定格假状态）
export function offFrame(ledCount = LED_COUNT) {
  return Array.from({ length: ledCount }, () => "0,0,0").join(";") + "\n";
}

// rows 已按 ageSec 升序（最活跃在前，见 core/scanner.js）。取前 ledCount 个，不足补 EMPTY。
// 返回一帧字符串："R,G,B;R,G,B;R,G,B;R,G,B\n"
export function buildFrame(rows, ledCount = LED_COUNT) {
  const slots = [];
  for (let i = 0; i < ledCount; i++) {
    const st = rows[i] && rows[i].state;
    slots.push(STATE_RGB[st] || EMPTY);
  }
  return slots.map(([r, g, b]) => `${r},${g},${b}`).join(";") + "\n";
}
