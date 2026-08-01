// core/status.js
// 纯函数：把 provider 吐出的「客户端无关原始信号」+ 文件年龄，统一分档成
// WORKING / WAITING / DONE / RECENT。它不认识任何 provider，只吃归一化输入。
// 判活口径集中在此一处，未来调规则只改这里，对所有客户端一致生效。

export const DEFAULT_WORKING_SEC = 30;      // < 30s 无修改视为正在运行
export const DEFAULT_RECENT_SEC = 5 * 60;   // 30s ~ 5min 视为刚停下

/**
 * @param {Object} p
 * @param {number} p.ageSec       文件距今多少秒未变动
 * @param {import('./providers/types.js').RawSignal} p.sig  provider 的原始信号
 * @param {number} p.workingSec   小于此秒数视为正在运行
 * @returns {{ state: string, activity: string }}
 */
export function classify({ ageSec, sig, workingSec = DEFAULT_WORKING_SEC }) {
  if (sig.waiting) {
    // 等待用户确认/回答：优先级最高，不受 age 影响（可能等很久也仍是等待）
    return { state: "WAITING", activity: sig.activity };
  }
  if (ageSec < workingSec && !sig.done) {
    // 文件刚动过，且本轮尚未结束 —— 确实在运行
    return { state: "WORKING", activity: sig.activity };
  }
  if (sig.done) {
    // 本轮已结束（AI 回复完）—— 显示为已完成，而非“正在运行”
    return { state: "DONE", activity: sig.activity };
  }
  // workingSec~recentSec 内动过但读不出明确结束标志
  return { state: "RECENT", activity: "" };
}
