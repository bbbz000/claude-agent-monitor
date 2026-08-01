// core/providers/opencode.js
// OpenCode Desktop 适配器 —— 【纯日志】方案（零原生依赖）。
//
// 背景：OpenCode 把会话存在 SQLite（opencode.db，WAL），但那是「原子落库」——
// AI 正在思考/流式回复的那段时间，库里【零写入】、mtime 不动，轮询 SQLite 根本抓不到
// 「工作中」窗口（灯只会卡在黄）。而 OpenCode 的后台 server 会实时把状态写进日志：
//   ~/.local/share/opencode/log/opencode.log
// 日志里每一轮工作的生命周期非常干净：
//   message=loop step=0        → 开始一轮
//   message=stream …           → 正在生成 / 调工具（工作中）
//   message=loop step=N        → 多步推进（工作中）
//   message=process …          → 处理某条消息（工作中）
//   message="exiting loop"     → 本轮收尾（已完成）
// 且日志是实时追加写的——这恰好补上 SQLite 抓不到的「进行中」窗口。
//
// 取舍：本方案【不读 SQLite】，因此零原生依赖（不需要 better-sqlite3 / rebuild）。
// 代价：日志会滚动，只覆盖近期活动——历史全量会话列表会退化为「日志窗口内出现过的会话」。
// 这是用户明确选择的权衡（换零依赖 + 实时判活）。
//
// 会话标识：OpenCode 无 per-session 文件，用合成 file = "opencode://<sid>" 作查表键/透传占位。
import fs from "fs";
import path from "path";
import os from "os";
import { readTail } from "./_shared.js";

// ── 路径发现 ─────────────────────────────────────────
// 默认日志路径（可被 cfg.logPath 覆盖）。source: "manual"（手填）/ "default"（默认位置）。
function resolveLogPath(override) {
  if (typeof override === "string" && override.trim()) {
    return { log: override.trim(), source: "manual" };
  }
  return {
    log: path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log"),
    source: "default",
  };
}

// ── 日志解析 ─────────────────────────────────────────
// 只读日志尾部若干字节（近期活动足矣，避免把上百 MB 日志全载入）。
const TAIL_BYTES = 512 * 1024;

// 一条会话在日志里的「活动种类」：work=进行中，done=已收尾。
// 事件优先级：任何 exiting loop 之后再出现 stream/loop/process → 又开工，故只认【最后一条】。
const RE_TS = /timestamp=([0-9T:.Z-]+)/;
const RE_ACT_SID = /session\.id=(ses_[A-Za-z0-9]+)/;   // stream/loop/process/exiting 都用这个
const RE_CREATED = /message=created\b/;
const RE_CREATED_ID = /\bid=(ses_[A-Za-z0-9]+)/;
const RE_DIR = /directory="((?:[^"\\]|\\.)*)"/;         // 值里含转义反斜杠
const RE_TITLE = /title="((?:[^"\\]|\\.)*)"/;

function tsToMs(s) {
  // 不用 Date.parse 直接给毫秒——ISO 串可靠；解析失败给 0。
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// created 行里 directory/title 的值是双重转义（\\ → 实际一个 \）。还原成可读路径。
function unescapeLogValue(v) {
  return (v || "").replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

// 从 directory 兜底出一个可读标题（尾段目录名），比 "New session - 时间戳" 有意义。
function titleFromDir(dir) {
  if (!dir) return "";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

// 扫描日志尾部，产出 Map<sid, { title, directory, kind, tsMs }>。
//   kind: "work" | "done"（最后一条活动事件决定）
//   title/directory: 若日志窗口内有该会话的 created 行则带上，否则为空
function parseLog(text) {
  const byId = new Map();
  const get = (sid) => {
    let e = byId.get(sid);
    if (!e) { e = { title: "", directory: "", kind: null, tsMs: 0 }; byId.set(sid, e); }
    return e;
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    const tsMs = tsToMs((line.match(RE_TS) || [])[1]);

    // created：拿标题/目录（元数据，不改变活动 kind）
    if (RE_CREATED.test(line)) {
      const sid = (line.match(RE_CREATED_ID) || [])[1];
      if (sid) {
        const e = get(sid);
        const dir = unescapeLogValue((line.match(RE_DIR) || [])[1]);
        const title = unescapeLogValue((line.match(RE_TITLE) || [])[1]);
        if (dir) e.directory = dir;
        if (title) e.title = title;
      }
      continue;
    }

    // 活动事件：stream / loop / process / exiting loop
    const sid = (line.match(RE_ACT_SID) || [])[1];
    if (!sid) continue;
    let kind = null;
    if (line.includes('message="exiting loop"')) kind = "done";
    else if (/message=(stream|loop|process)\b/.test(line)) kind = "work";
    if (!kind) continue;

    const e = get(sid);
    // 只认最后一条活动（tsMs 更大或相等的后来者覆盖）——日志本就时间升序，直接覆盖即可。
    if (tsMs >= e.tsMs) { e.tsMs = tsMs; e.kind = kind; }
  }
  return byId;
}

// 由日志条目算 { activity, done, waiting }。OpenCode 无 AskUserQuestion 显式信号 → waiting 恒 false。
function signalFrom(entry) {
  if (!entry || !entry.kind) return { activity: "", done: false, waiting: false };
  if (entry.kind === "done") return { activity: "已回复", done: true, waiting: false };
  return { activity: "工作中", done: false, waiting: false }; // work
}

// ── 发现会话 ─────────────────────────────────────────
// scanner 只把 session.file（字符串）回传给 parseMeta/parseActivity，不回传会话对象。
// 故 discover 一次扫描时把每个会话的 meta/sig 按 file 键缓存，供 parseMeta/parseActivity 查表。
const metaCache = new Map(); // file -> { meta, sig }

function readLogEntries(logPath) {
  let st;
  try { st = fs.statSync(logPath); } catch { return null; }
  if (!st.isFile()) return null;
  let text;
  try { text = readTail(logPath, st.size, TAIL_BYTES); } catch { return null; }
  return parseLog(text);
}

function discover(cfg = {}) {
  const { log: logPath } = resolveLogPath(cfg.logPath);
  const byId = readLogEntries(logPath);
  if (!byId) return [];

  const out = [];
  metaCache.clear(); // 每轮重建，只保留本轮日志里出现的会话
  for (const [sid, e] of byId) {
    if (!e.kind) continue; // 只有 created、从没活动过 → 不作为活跃会话展示
    const file = `opencode://${sid}`;
    const title = e.title || titleFromDir(e.directory) || "(OpenCode 会话)";
    const meta = {
      title,
      firstMsg: "",
      cwd: e.directory || "",
      gitBranch: "",
      startTime: "",
    };
    const sig = signalFrom(e);
    metaCache.set(file, { meta, sig });
    out.push({
      file,
      sessionId: sid,
      project: e.directory || "",
      mtimeMs: e.tsMs,   // 用日志事件时间戳 → ageSec 反映真实活动新鲜度（修复「灯卡黄」根因）
      size: 0,
    });
  }
  return out;
}

// scanner 把 discover 返回的 session.file（字符串）回传进来 → 据它查 discover 时算好的缓存。
function parseMeta(file) {
  const c = metaCache.get(file);
  return c ? { title: c.meta.title } : { title: "(OpenCode 会话)" };
}

function parseFullMeta(file) {
  const c = metaCache.get(file);
  return c ? c.meta : { title: "(OpenCode 会话)", firstMsg: "", cwd: "", gitBranch: "", startTime: "" };
}

function parseActivity(file) {
  const c = metaCache.get(file);
  return c ? c.sig : { activity: "", done: false, waiting: false };
}

// ── 检测（设置界面「检测」按钮）───────────────────────
// 纯只读：检查日志文件存在/可读，统计近期出现过活动的会话数。
function probe(cfg = {}) {
  const { log: logPath, source } = resolveLogPath(cfg.logPath);
  const res = { root: logPath, source, exists: false, isDir: false, sessionCount: 0, error: null };
  let st;
  try {
    st = fs.statSync(logPath);
    res.exists = true;
    res.isDir = st.isDirectory();
    // OpenCode 的日志应是【文件】。若指到目录 → 明确报错（前端按 error 显示失败）。
    if (res.isDir) { res.error = "该路径是目录，应指向 opencode.log 文件"; return res; }
  } catch (e) {
    if (e && e.code !== "ENOENT") res.error = e.message;
    return res;
  }
  const byId = readLogEntries(logPath);
  if (!byId) { res.error = "无法读取日志"; return res; }
  let n = 0;
  for (const [, e] of byId) if (e.kind) n++;
  res.sessionCount = n;
  return res;
}

/** @type {import('./types.js').Provider} */
const opencodeProvider = {
  id: "opencode",
  label: "OpenCode",
  // 配置字段：一个 opencode.log 路径覆盖（空=自动检测默认位置）。
  configSchema: [
    { key: "logPath", type: "path", label: "日志文件", placeholder: "留空自动检测 opencode.log" },
  ],
  discover,
  parseMeta,
  parseFullMeta,
  parseActivity,
  probe,
};

export default opencodeProvider;
