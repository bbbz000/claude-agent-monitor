// core/providers/claude.js
// Claude Code / Desktop 适配器。
// 会话以 .jsonl 明文存于 <.claude>/projects/<项目目录>/<sessionId>.jsonl。
// 本文件里的解析逻辑全部原样迁自旧 core/scanner.js（行为不变），只是包成统一的 Provider 接口。
import fs from "fs";
import path from "path";
import os from "os";
import { readHead, readTail, extractText } from "./_shared.js";

// ── 路径发现 ─────────────────────────────────────────
// projects 根目录解析（优先级：显式覆盖 > CLAUDE_CONFIG_DIR 环境变量 > 默认 ~/.claude）。
// Claude Code 用 CLAUDE_CONFIG_DIR 指向 .claude 目录本身，会话在其下 projects/。
// override 传的是 .claude 根目录（与环境变量语义一致），内部统一拼 /projects。
// source: "manual"（手动填）/ "env"（环境变量）/ "default"（~/.claude）
function resolveBase(override) {
  if (typeof override === "string" && override.trim()) return { base: override.trim(), source: "manual" };
  const env = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
  if (env) return { base: env, source: "env" };
  return { base: path.join(os.homedir(), ".claude"), source: "default" };
}

function resolveProjectsRoot(override) {
  return path.join(resolveBase(override).base, "projects");
}

// 把 projects 目录名（C--Users-...）尽量还原成可读路径
function decodeProject(name) {
  return name.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/");
}

// ── 标题解析（读文件头，带缓存）───────────────────────
// 读一次文件头，解析出标题所需字段 + 历史列表需要的额外字段（cwd/gitBranch/startTime/firstMsg）。
// parseMeta（只要 title，供 scan 判活）与 parseFullMeta（全字段，供 sessions 历史列表）共享它。
const headCache = new Map(); // sid -> full meta（含 title + 额外字段）
function readHeadMeta(fp, sid) {
  if (headCache.has(sid)) return headCache.get(sid);
  let title = "", ai = "", firstMsg = "", cwd = "", gitBranch = "", startTime = "";
  for (const ln of readHead(fp).split("\n").filter(Boolean).slice(0, 20)) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    else if (o.type === "ai-title" && o.aiTitle) ai = o.aiTitle;
    if (!firstMsg && o.type === "user" && o.message) firstMsg = extractText(o.message.content);
    if (!firstMsg && o.type === "queue-operation" && o.content) firstMsg = o.content;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
    if (!startTime && o.timestamp) startTime = o.timestamp;
  }
  const meta = {
    title: title || ai || firstMsg.trim() || "(无标题)",
    firstMsg: firstMsg.trim(),
    cwd, gitBranch, startTime,
  };
  headCache.set(sid, meta);
  return meta;
}

// 只取判活/显示用的标题（scan 走这条）
function parseMetaFor(fp, sid) {
  return { title: readHeadMeta(fp, sid).title };
}

// ── 活动细分 ─────────────────────────────────────────
// 工具名 → 细分活动文字。用于把 tool_use 那一步显示成人话。
function toolActivity(name) {
  if (name === "Bash") return "执行命令";
  if (name === "Read" || name === "Grep" || name === "Glob") return "读取/搜索";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "写文件";
  if (name === "WebSearch" || name === "WebFetch") return "联网";
  if (name === "Agent" || name === "Task" || /^Task/.test(name || "")) return "子任务";
  return name ? `调用 ${name}` : "调用工具";
}

// 需要用户回应的工具：命中即视为 WAITING（等待你确认/回答）
const WAITING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

// 读尾部推断当前处于什么阶段。返回 { activity, done, waiting }
function parseActivityFor(fp, size) {
  try {
    const lines = readTail(fp, size).split("\n").filter(Boolean);
    // 从后往前找第一条“实质消息”（assistant / user），跳过 last-prompt /
    // custom-title / ai-title / mode 等收尾元数据行——它们常追加在会话末尾，
    // 是“本轮已结束”的信号，而不是还在运行。
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }

      if (o.type === "assistant" && o.message) {
        const stop = o.message.stop_reason;
        if (stop === "tool_use") {
          const c = o.message.content;
          const tu = Array.isArray(c) ? c.filter((x) => x.type === "tool_use").pop() : null;
          const name = tu && tu.name;
          if (name && WAITING_TOOLS.has(name)) {
            return { activity: "等待你确认/回答", done: false, waiting: true };
          }
          return { activity: toolActivity(name), done: false, waiting: false };
        }
        if (stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens")
          return { activity: "已回复", done: true, waiting: false };
        // stop_reason 为 null / 缺失：多为流式写入中，确实在生成
        return { activity: "AI 回复中", done: false, waiting: false };
      }

      if (o.type === "user" && o.message) {
        const c = o.message.content;
        const isToolResult = Array.isArray(c) && c.some((x) => x.type === "tool_result");
        if (isToolResult) return { activity: "工具执行中", done: false, waiting: false };
        return { activity: "等待 AI", done: false, waiting: false };
      }
    }
  } catch {}
  return { activity: "", done: false, waiting: false };
}

// ── 发现会话文件 ─────────────────────────────────────
// cfg.configDir：可选的 .claude 根目录覆盖（设置里手动填的）；不传则走环境变量/默认。
function discover(cfg = {}) {
  const root = resolveProjectsRoot(cfg.configDir);
  const out = [];
  if (!fs.existsSync(root)) return out;

  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith(".jsonl")) continue;
      const fp = path.join(dir, fn);
      let fst; try { fst = fs.statSync(fp); } catch { continue; }
      out.push({
        file: fp,
        sessionId: fn.replace(/\.jsonl$/, ""),
        project: decodeProject(proj),
        projectKey: proj,          // 原始编码目录名，供按内部键过滤
        mtimeMs: fst.mtimeMs,
        size: fst.size,
      });
    }
  }
  return out;
}

// ── 检测（设置界面「检测」按钮）───────────────────────
// 纯只读，返回统一 ProbeResult 形状。
function probe(cfg = {}) {
  const { base, source } = resolveBase(cfg.configDir);
  const root = path.join(base, "projects");
  const res = { root, source, exists: false, isDir: false, sessionCount: 0, error: null };
  try {
    const st = fs.statSync(root);
    res.exists = true;
    res.isDir = st.isDirectory();
    // Claude 的会话根应是【目录】(projects/)。若指到文件 → 明确报错，
    // 供前端按 error 显示失败（前端已中性化，不再自行判 isDir）。
    if (!res.isDir) { res.error = "该路径不是目录（应指向 .claude 下的 projects 目录）"; return res; }
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      let dst; try { dst = fs.statSync(dir); } catch { continue; }
      if (!dst.isDirectory()) continue;
      for (const fn of fs.readdirSync(dir)) {
        if (fn.endsWith(".jsonl")) res.sessionCount++;
      }
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") res.error = e.message;
  }
  return res;
}

/** @type {import('./types.js').Provider} */
const claudeProvider = {
  id: "claude",
  label: "Claude Code",
  // 配置字段声明：Claude 只需一个 .claude 根目录覆盖（空=自动检测）。
  // 设置界面据此渲染出「数据目录」路径框；probe 时整包传进来，这里只读 configDir。
  configSchema: [
    { key: "configDir", type: "path", label: "数据目录", placeholder: "留空自动检测" },
  ],
  discover,
  parseMeta: (file) => parseMetaFor(file, path.basename(file).replace(/\.jsonl$/, "")),
  parseFullMeta: (file) => readHeadMeta(file, path.basename(file).replace(/\.jsonl$/, "")),
  parseActivity: parseActivityFor,
  probe,
};

export default claudeProvider;

// 兼容既有 import（sessions.js 曾直接引这两个）——过渡期保留导出。
export { resolveProjectsRoot, decodeProject };
