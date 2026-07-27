import { scan } from "./core/scanner.js";

// ── 配置 ─────────────────────────────────────────────
const WORKING_SEC = 30;        // < 30s 无修改视为正在运行
const RECENT_SEC = 5 * 60;     // 30s ~ 5min 视为刚停下
const REFRESH_MS = 2000;       // 面板刷新间隔
const MAX_ROWS = 15;           // 最多显示多少个 agent

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
  magenta: "\x1b[35m",
};

// ── 渲染 ─────────────────────────────────────────────
function fmtAge(sec) {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  return `${(sec / 60).toFixed(0)}m`;
}

function render(rows) {
  const clear = "\x1b[2J\x1b[H"; // 清屏 + 光标归位
  let out = clear;
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  out += `${C.cyan}${C.bold}╔═══════════════════════════════════════════════════════════╗${C.reset}\n`;
  out += `${C.cyan}${C.bold}║  Claude Agent Monitor          活跃 agent 实时状态         ║${C.reset}\n`;
  out += `${C.cyan}${C.bold}╚═══════════════════════════════════════════════════════════╝${C.reset}\n`;

  const working = rows.filter((r) => r.state === "WORKING").length;
  const waiting = rows.filter((r) => r.state === "WAITING").length;
  out += `${C.dim}${now}   共 ${rows.length} 个近期活跃 · ${C.reset}${C.green}${working} 个正在运行${C.reset}`;
  if (waiting) out += ` ${C.magenta}· ${waiting} 个等你确认${C.reset}`;
  out += `\n\n`;

  if (rows.length === 0) {
    out += `${C.gray}   （近 5 分钟内没有活跃的 agent）${C.reset}\n`;
  }

  for (const r of rows.slice(0, MAX_ROWS)) {
    let dot, label, color;
    if (r.state === "WAITING") { dot = "◆"; label = "WAITING"; color = C.magenta; }
    else if (r.state === "WORKING") { dot = "●"; label = "WORKING"; color = C.green; }
    else if (r.state === "DONE") { dot = "✓"; label = "DONE   "; color = C.cyan; }
    else { dot = "◐"; label = "RECENT "; color = C.yellow; }

    const age = fmtAge(r.ageSec).padStart(4);
    out += `${color}${dot} ${label}${C.reset} ${C.dim}${age}前${C.reset}  ${C.bold}${C.white}${r.title.slice(0, 40)}${C.reset}\n`;
    const sub = [`${C.gray}${r.sid.slice(0, 8)}${C.reset}`, `${C.dim}${r.project.slice(0, 40)}${C.reset}`];
    if (r.activity) sub.push(`${C.cyan}${r.activity}${C.reset}`);
    out += `            ${sub.join("  ")}\n`;
  }

  out += `\n${C.dim}每 ${REFRESH_MS / 1000}s 刷新 · ◆等你确认 ●运行中 ✓已回复 ◐近期 · Ctrl+C 退出${C.reset}\n`;
  process.stdout.write(out);
}

// ── 主循环 ───────────────────────────────────────────
console.log("启动中，扫描 Claude 会话...");
function tick() {
  try { render(scan({ workingSec: WORKING_SEC, recentSec: RECENT_SEC })); }
  catch (e) { process.stdout.write(`${C.red}扫描出错: ${e.message}${C.reset}\n`); }
}
tick();
const timer = setInterval(tick, REFRESH_MS);

process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write(`\n${C.dim}Monitor 已停止。${C.reset}\n`);
  process.exit(0);
});
