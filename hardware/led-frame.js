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

// 活跃度归一化窗口（秒）：指针从满偏线性掉回静止端所需时间。
// 取 60s（1 分钟）——用户要指针掉得更利落；判活口径（RECENT/黄灯）另在 core/status.js，两者独立。
// 这里内联常量而非 import core/，是为了守住本文件"零依赖"的定位（见文件头注释）。
export const RECENT_SEC = 60;

// 活跃度 0..255：agent 越活跃（ageSec 越小）值越大。
// ageSec=0 → 255；ageSec>=recentSec → 0（此时它也快掉出 scan 列表了）。空槽调用方传 null → 0。
export function activityOf(ageSec, recentSec = RECENT_SEC) {
  if (ageSec == null || !(recentSec > 0)) return 0;
  const t = 1 - ageSec / recentSec;      // 1=最活跃, 0=最久
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.round(clamped * 255);
}

// 全灭帧（退出/断开时发，避免灯定格假状态）。活跃度段一并归零，让指针表头回落。
export function offFrame(ledCount = LED_COUNT) {
  const rgb = Array.from({ length: ledCount }, () => "0,0,0").join(";");
  const act = Array.from({ length: ledCount }, () => "0").join(",");
  return `${rgb}|${act}\n`;
}

// rows 已按 ageSec 升序（最活跃在前，见 core/scanner.js）。取前 ledCount 个，不足补 EMPTY。
// 返回一帧字符串："R,G,B;R,G,B;R,G,B;R,G,B|A0,A1,A2,A3\n"
//   分号段 = 各槽 RGB（状态颜色，唯一可辨状态）；
//   管道段 = 各槽活跃度 0..255（连续量，供指针表头等模拟输出用）。
// 【向后兼容】只认 ; 和 \n 的旧固件会忽略 | 段：取最后一组 B 时 String::toInt() 遇 '|' 即停，
//   B 值不被污染（见 PROTOCOL.md 的兼容说明）。所以老硬件插上照常只点灯，不受影响。
export function buildFrame(rows, ledCount = LED_COUNT, recentSec = RECENT_SEC) {
  const slots = [];
  const acts = [];
  for (let i = 0; i < ledCount; i++) {
    const row = rows[i];
    slots.push(STATE_RGB[row && row.state] || EMPTY);
    acts.push(activityOf(row ? row.ageSec : null, recentSec));
  }
  const rgb = slots.map(([r, g, b]) => `${r},${g},${b}`).join(";");
  return `${rgb}|${acts.join(",")}\n`;
}
