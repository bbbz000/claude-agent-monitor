import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveProjectsRoot } from "./core/scanner.js";

// Claude Code / Desktop agent 会话都以 .jsonl 存在 <.claude>/projects/<项目>/<sessionId>.jsonl
// 复用 scanner 的解析：自动适配 CLAUDE_CONFIG_DIR 环境变量，否则默认 ~/.claude。
const PROJECTS_ROOT = resolveProjectsRoot();

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

// 只读文件头部若干字节，避免把上百 KB 的会话整个载入
function readHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const len = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, len);
  } finally {
    fs.closeSync(fd);
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return "";
}

// 把 projects 目录名（C--Users-...）尽量还原成可读路径
function decodeProject(name) {
  return name.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/");
}

function parseSession(filePath, sessionId) {
  const stat = fs.statSync(filePath);
  const lines = readHead(filePath).split("\n").filter(Boolean);

  let title = "";       // custom-title 优先，其次 ai-title
  let aiTitle = "";
  let firstMsg = "";
  let cwd = "";
  let gitBranch = "";
  let startTime = "";

  for (const line of lines.slice(0, 20)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    else if (o.type === "ai-title" && o.aiTitle) aiTitle = o.aiTitle;
    if (!firstMsg && o.type === "user" && o.message) firstMsg = extractText(o.message.content);
    if (!firstMsg && o.type === "queue-operation" && o.content) firstMsg = o.content;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
    if (!startTime && o.timestamp) startTime = o.timestamp;
  }

  return {
    sessionId,
    title: title || aiTitle || firstMsg.trim() || "(无标题)",
    firstMsg: firstMsg.trim(),
    cwd,
    gitBranch,
    startTime,
    mtime: stat.mtime,
    size: stat.size,
    file: filePath,
  };
}

export function listSessions() {
  const sessions = [];
  if (!fs.existsSync(PROJECTS_ROOT)) return sessions;

  for (const proj of fs.readdirSync(PROJECTS_ROOT)) {
    const dir = path.join(PROJECTS_ROOT, proj);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith(".jsonl")) continue;
      const fp = path.join(dir, fn);
      try {
        const s = parseSession(fp, fn.replace(/\.jsonl$/, ""));
        s.project = proj;
        s.projectPath = decodeProject(proj);
        sessions.push(s);
      } catch {
        // 跳过损坏文件
      }
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// 直接运行时打印列表
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const argPath = path.resolve(process.argv[1]);
  const thisPath = fileURLToPath(import.meta.url);
  return argPath === thisPath;
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const limit = (() => {
    const i = args.indexOf("--limit");
    return i >= 0 ? parseInt(args[i + 1], 10) : 30;
  })();
  const filter = (() => {
    const i = args.indexOf("--project");
    return i >= 0 ? args[i + 1] : null;
  })();

  let sessions = listSessions();
  if (filter) sessions = sessions.filter((s) => s.projectPath.includes(filter) || s.project.includes(filter));

  if (asJson) {
    console.log(JSON.stringify(sessions.slice(0, limit), null, 2));
  } else {
    const C = COLORS;
    console.log(`${C.cyan}${C.bold}Claude Agent Sessions${C.reset}  ${C.dim}(共 ${sessions.length} 个，显示前 ${Math.min(limit, sessions.length)} 个)${C.reset}\n`);
    for (const s of sessions.slice(0, limit)) {
      const t = s.mtime.toISOString().slice(0, 16).replace("T", " ");
      const kb = (s.size / 1024).toFixed(0).padStart(4) + "KB";
      console.log(
        `${C.dim}${t}${C.reset}  ${C.green}${s.sessionId.slice(0, 8)}${C.reset}  ${C.dim}${kb}${C.reset}  ${C.bold}${s.title.slice(0, 50)}${C.reset}`
      );
      console.log(`${C.dim}            └ ${s.projectPath}${s.gitBranch ? "  @" + s.gitBranch : ""}${C.reset}`);
    }
  }
}
