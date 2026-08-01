import path from "path";
import { fileURLToPath } from "url";
import { allProviders } from "./core/providers/registry.js";

// 历史 session 列表：遍历所有 provider（含未启用的——查历史与启用状态无关），
// 用各自的 discover() 发现会话文件、parseFullMeta() 拿完整元信息。
// 解析逻辑全在 provider 里，本文件不再自带 readHead/parseSession（P2 消除重复）。

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

export function listSessions() {
  const sessions = [];
  for (const p of allProviders()) {
    let discovered;
    try { discovered = p.discover({}); } catch { continue; } // 单个 provider 挂了不影响其他
    for (const d of discovered) {
      try {
        // parseFullMeta 拿全字段；provider 若未实现则退回 parseMeta（只有 title）
        const meta = p.parseFullMeta ? p.parseFullMeta(d.file) : p.parseMeta(d.file);
        sessions.push({
          provider: p.id,
          sessionId: d.sessionId,
          title: meta.title,
          firstMsg: meta.firstMsg || "",
          cwd: meta.cwd || "",
          gitBranch: meta.gitBranch || "",
          startTime: meta.startTime || "",
          mtime: new Date(d.mtimeMs),
          size: d.size,
          file: d.file,
          projectPath: d.project,
          projectKey: d.projectKey || "", // 原始内部键（如 Claude 编码目录名），供过滤
        });
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
  if (filter) sessions = sessions.filter((s) => (s.projectPath || "").includes(filter) || (s.projectKey || "").includes(filter));

  if (asJson) {
    console.log(JSON.stringify(sessions.slice(0, limit), null, 2));
  } else {
    const C = COLORS;
    console.log(`${C.cyan}${C.bold}Agent Sessions${C.reset}  ${C.dim}(共 ${sessions.length} 个，显示前 ${Math.min(limit, sessions.length)} 个)${C.reset}\n`);
    for (const s of sessions.slice(0, limit)) {
      const t = s.mtime.toISOString().slice(0, 16).replace("T", " ");
      const kb = (s.size / 1024).toFixed(0).padStart(4) + "KB";
      console.log(
        `${C.dim}${t}${C.reset}  ${C.yellow}[${s.provider}]${C.reset} ${C.green}${s.sessionId.slice(0, 8)}${C.reset}  ${C.dim}${kb}${C.reset}  ${C.bold}${s.title.slice(0, 50)}${C.reset}`
      );
      console.log(`${C.dim}            └ ${s.projectPath}${s.gitBranch ? "  @" + s.gitBranch : ""}${C.reset}`);
    }
  }
}
