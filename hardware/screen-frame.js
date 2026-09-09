// hardware/screen-frame.js
// 纯函数：把 scan() 的会话行数组 + 系统指标 → 屏幕板一帧 JSON 字符串。
// 零依赖，供 screen-serial.js 使用。协议真相源见 hardware/SCREEN_PROTOCOL.md。
//
// 为什么用 JSON 而非 LED 那种 ; 分隔：会话标题/项目名含空格与中文，分隔符不安全；
// 屏幕板有 8MB PSRAM / 16MB flash，ArduinoJson 解析开销可忽略，换来鲁棒性与可扩展性。

// 单条会话在帧里的字段上限：标题/项目名过长会撑爆屏幕行宽，PC 侧先截断省串口带宽。
// 屏幕横排 400px、12px 中文字体约能显 ~24 个全角字，留些余量取 28 字（中英混排偏保守）。
const MAX_TITLE = 28;
const MAX_PROJECT = 24;

// 默认最多显示几条会话（屏高 300 减去顶栏+指标带，每条 ~2.5 行，约容 6 条）。
export const DEFAULT_MAX_SESSIONS = 6;

// state 里哪些算“等你确认”，需要在屏幕上闪烁边框提醒。目前只有 WAITING。
function isWaiting(state) {
  return state === "WAITING";
}

// 截断到 n 个字符（按 code point，避免把中文/emoji 截半）。超出加省略号。
function truncate(s, n) {
  if (s == null) return "";
  const str = String(s);
  const chars = Array.from(str); // 按 code point 切，中文算 1
  if (chars.length <= n) return str;
  return chars.slice(0, n - 1).join("") + "…";
}

// 把一行 scan 结果裁成屏幕帧里的紧凑单条。
function slimSession(row) {
  const s = {
    st: row.state || "",                          // 状态：WORKING/WAITING/DONE/RECENT
    ti: truncate(row.title, MAX_TITLE),           // 标题（截断）
    pj: truncate(row.project, MAX_PROJECT),       // 项目名（截断）
    pv: row.providerLabel || row.provider || "",  // 来源可读名，如 "Claude Code"
    age: Math.round(row.ageSec || 0),             // 距今秒数（整数）
    w: isWaiting(row.state),                       // 是否等待确认 → 驱动边框闪烁
  };
  // 上下文占用%（0..100）。null=非 Claude/读不到 usage → 省略该字段省带宽，固件按"未知"不显示。
  if (row.ctxPct != null) s.cx = clampPct(row.ctxPct);
  // 剩余存活%（0..100）：距本条因超过 recentSec 未活动被过滤、从列表消失的倒计时。
  // 满=刚活动过，空=即将消失。所有会话都有（scan 恒算出），固件画在 ctx 条右侧、同一行。
  if (row.lifePct != null) s.lf = clampPct(row.lifePct);
  return s;
}

/**
 * 构造屏幕板一帧。rows 已按 ageSec 升序（最活跃在前，见 core/scanner.js）。
 * @param {Array} rows                scan() 返回的完整行数组
 * @param {Object} [metrics]          { t?:string(HH:MM), cpu?:number, mem?:number, act?:boolean }
 * @param {number} [maxSessions]      最多带几条会话
 * @returns {string} 一行 JSON + "\n"
 */
export function buildScreenFrame(rows = [], metrics = {}, maxSessions = DEFAULT_MAX_SESSIONS) {
  const n = Math.max(0, maxSessions | 0);
  const sessions = (rows || []).slice(0, n).map(slimSession);
  const frame = {
    t: typeof metrics.t === "string" ? metrics.t : "",
    cpu: clampPct(metrics.cpu),
    mem: clampPct(metrics.mem),
    total: (rows || []).length, // 会话总数（可能 > 显示条数，屏幕可提示 +N）
    act: metrics.act ? 1 : 0,   // 用户近期有输入（鼠标/键盘）→ 固件用来唤醒/维持不待机
    sessions,
  };
  return JSON.stringify(frame) + "\n";
}

// 全清帧（退出/断开时发，避免屏幕定格假状态）。
export function offScreenFrame() {
  return JSON.stringify({ off: true }) + "\n";
}

// 把百分比夹到 0..100 整数；非数字 → 0。
function clampPct(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 100 ? 100 : n;
}
