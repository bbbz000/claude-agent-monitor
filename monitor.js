import fs from "fs";
import path from "path";
import os from "os";

// ── 配置 ─────────────────────────────────────────────
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");
const WORKING_SEC = 30;        // < 30s 无修改视为正在运行
const RECENT_SEC = 5 * 60;     // 30s ~ 5min 视为刚停下
const REFRESH_MS = 2000;       // 面板刷新间隔
const MAX_ROWS = 15;           // 最多显示多少个 agent

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", gray: "\x1b[90m", white: "\x1b[37m",
};

// ── 工具函数 ─────────────────────────────────────────
function readHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, n);
  } finally { fs.closeSync(fd); }
}

function readTail(file, size, bytes = 8192) {
  const want = Math.min(size, bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString("utf-8");
  } finally { fs.closeSync(fd); }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return "";
}

function decodeProject(name) {
  return name.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/");
}

// 读文件头拿标题 / 首个提问（带简单缓存，避免每次刷新重复读整头）
const headCache = new Map(); // sid -> {title, firstMsg}
function getMeta(fp, sid) {
  if (headCache.has(sid)) return headCache.get(sid);
  let title = "", ai = "", firstMsg = "";
  for (const ln of readHead(fp).split("\n").filter(Boolean).slice(0, 20)) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    else if (o.type === "ai-title" && o.aiTitle) ai = o.aiTitle;
    if (!firstMsg && o.type === "user" && o.message) firstMsg = extractText(o.message.content);
    if (!firstMsg && o.type === "queue-operation" && o.content) firstMsg = o.content;
  }
  const meta = { title: title || ai || firstMsg.trim() || "(无标题)" };
  headCache.set(sid, meta);
  return meta;
}

// 读尾部推断当前处于什么阶段。返回 { activity, done }
// done=true 表示这一轮已结束（AI 已回复完 end_turn 或用户消息尚未被处理之外的收尾），
// 用于避免把「已处理完」误显示成「AI 回复中」。
function getActivity(fp, size) {
  try {
    const lines = readTail(fp, size).split("\n").filter(Boolean);
    // 从后往前找第一条“实质消息”（assistant / user），跳过 last-prompt /
    // custom-title / ai-title / mode 等收尾元数据行——它们常追加在会话末尾，
    // 是“本轮已结束”的信号，而不是还在运行。
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }

      if (o.type === "assistant" && o.message) {
        const stop = o.message.stop_reason;
        if (stop === "tool_use") return { activity: "调用工具", done: false };
        if (stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens")
          return { activity: "已回复", done: true };
        // stop_reason 为 null / 缺失：多为流式写入中，确实在生成
        return { activity: "AI 回复中", done: false };
      }

      if (o.type === "user" && o.message) {
        const c = o.message.content;
        // 工具结果回填也是 user 消息，content 里是 tool_result
        const isToolResult = Array.isArray(c) && c.some((x) => x.type === "tool_result");
        if (isToolResult) return { activity: "工具执行中", done: false };
        return { activity: "等待 AI", done: false }; // 用户刚发消息，等 AI 接手
      }
    }
  } catch {}
  return { activity: "", done: false };
}

// ── 扫描所有 session，返回活跃列表 ────────────────────
function scan() {
  const now = Date.now();
  const rows = [];
  if (!fs.existsSync(PROJECTS_ROOT)) return rows;

  for (const proj of fs.readdirSync(PROJECTS_ROOT)) {
    const dir = path.join(PROJECTS_ROOT, proj);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith(".jsonl")) continue;
      const fp = path.join(dir, fn);
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      const ageSec = (now - fst.mtimeMs) / 1000;
      if (ageSec > RECENT_SEC) continue; // 只保留近 5 分钟内活动过的

      const sid = fn.replace(/\.jsonl$/, "");
      const meta = getMeta(fp, sid);

      // 先读尾部判断这一轮是否已结束
      const act = getActivity(fp, fst.size);

      let state, activity = act.activity;
      if (ageSec < WORKING_SEC && !act.done) {
        // 文件刚动过，且本轮尚未结束 —— 确实在运行
        state = "WORKING";
      } else if (act.done) {
        // 本轮已结束（AI 回复完）—— 显示为已完成，而非“正在运行”
        state = "DONE";
      } else {
        // 30s~5min 内动过但读不出明确结束标志
        state = "RECENT";
        activity = "";
      }

      rows.push({
        sid, state, ageSec, activity,
        title: meta.title,
        project: decodeProject(proj),
        mtime: fst.mtime,
      });
    }
  }
  rows.sort((a, b) => a.ageSec - b.ageSec); // 最活跃在最上
  return rows;
}

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
  out += `${C.dim}${now}   共 ${rows.length} 个近期活跃 · ${C.reset}${C.green}${working} 个正在运行${C.reset}\n\n`;

  if (rows.length === 0) {
    out += `${C.gray}   （近 5 分钟内没有活跃的 agent）${C.reset}\n`;
  }

  for (const r of rows.slice(0, MAX_ROWS)) {
    let dot, label, color;
    if (r.state === "WORKING") { dot = "●"; label = "WORKING"; color = C.green; }
    else if (r.state === "DONE") { dot = "✓"; label = "DONE   "; color = C.cyan; }
    else { dot = "◐"; label = "RECENT "; color = C.yellow; }

    const age = fmtAge(r.ageSec).padStart(4);
    out += `${color}${dot} ${label}${C.reset} ${C.dim}${age}前${C.reset}  ${C.bold}${C.white}${r.title.slice(0, 40)}${C.reset}\n`;
    const sub = [`${C.gray}${r.sid.slice(0, 8)}${C.reset}`, `${C.dim}${r.project.slice(0, 40)}${C.reset}`];
    if (r.activity) sub.push(`${C.cyan}${r.activity}${C.reset}`);
    out += `            ${sub.join("  ")}\n`;
  }

  out += `\n${C.dim}每 ${REFRESH_MS / 1000}s 刷新 · ●运行中 ✓已回复 ◐近期 · Ctrl+C 退出${C.reset}\n`;
  process.stdout.write(out);
}

// ── 主循环 ───────────────────────────────────────────
console.log("启动中，扫描 Claude 会话...");
function tick() {
  try { render(scan()); }
  catch (e) { process.stdout.write(`${C.red}扫描出错: ${e.message}${C.reset}\n`); }
}
tick();
const timer = setInterval(tick, REFRESH_MS);

process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write(`\n${C.dim}Monitor 已停止。${C.reset}\n`);
  process.exit(0);
});
