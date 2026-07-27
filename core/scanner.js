// core/scanner.js
// 纯逻辑模块：扫描 ~/.claude/projects 下的 .jsonl，推断各 agent 会话状态。
// 【重要】本模块绝不能有顶层执行代码（无 console / setInterval），
// 以便 monitor.js（终端版）与 electron/main.js（小条版）共享同一份判活逻辑。
import fs from "fs";
import path from "path";
import os from "os";

export const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

// 默认阈值（可被 scan() 的参数覆盖）
export const DEFAULT_WORKING_SEC = 30; // < 30s 无修改视为正在运行
export const DEFAULT_RECENT_SEC = 5 * 60; // 30s ~ 5min 视为刚停下

// ── 工具函数 ─────────────────────────────────────────
function readHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, size, bytes = 8192) {
  const want = Math.min(size, bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return "";
}

export function decodeProject(name) {
  return name.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/");
}

// 读文件头拿标题 / 首个提问（带简单缓存，避免每次刷新重复读整头）
const headCache = new Map(); // sid -> {title}
export function getMeta(fp, sid) {
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
// done=true 表示这一轮已结束（AI 已回复完 end_turn 等），
// 用于避免把「已处理完」误显示成「AI 回复中」。
export function getActivity(fp, size) {
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
// 阈值参数化：workingSec / recentSec 可由调用方（小条设置）覆盖。
export function scan({ workingSec = DEFAULT_WORKING_SEC, recentSec = DEFAULT_RECENT_SEC } = {}) {
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
      if (ageSec > recentSec) continue; // 只保留近 recentSec 内活动过的

      const sid = fn.replace(/\.jsonl$/, "");
      const meta = getMeta(fp, sid);

      // 先读尾部判断这一轮是否已结束
      const act = getActivity(fp, fst.size);

      let state, activity = act.activity;
      if (ageSec < workingSec && !act.done) {
        // 文件刚动过，且本轮尚未结束 —— 确实在运行
        state = "WORKING";
      } else if (act.done) {
        // 本轮已结束（AI 回复完）—— 显示为已完成，而非“正在运行”
        state = "DONE";
      } else {
        // workingSec~recentSec 内动过但读不出明确结束标志
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
