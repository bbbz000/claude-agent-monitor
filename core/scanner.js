// core/scanner.js
// 编排器：遍历已启用的 provider → 收集其发现的会话 → 交给 status.js 统一分档 → 汇总排序。
// 【重要】本模块绝不能有顶层执行代码（无 console / setInterval），
// 以便 monitor.js（终端版）与 electron/main.js（小条版）共享同一份逻辑。
//
// 与具体客户端彻底解耦：scanner 不认识 .jsonl、不认识 Claude 目录结构——那些都在 providers/ 里。
import { activeProviders, allProviders } from "./providers/registry.js";
import { classify, DEFAULT_WORKING_SEC, DEFAULT_RECENT_SEC } from "./status.js";

export { DEFAULT_WORKING_SEC, DEFAULT_RECENT_SEC };

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * 扫描所有启用 provider 的活跃会话，返回扁平行数组（最活跃在前）。
 * @param {Object} [opts]
 * @param {number} [opts.workingSec]
 * @param {number} [opts.recentSec]
 * @param {string[]} [opts.providers]        启用的 provider id 列表；见 registry.activeProviders 语义
 * @param {Object} [opts.providerConfigs]    { [providerId]: cfg }，各 provider 各自的配置
 * @param {string} [opts.configDir]          【兼容旧调用】等价于 providerConfigs.claude.configDir
 */
export function scan({
  workingSec = DEFAULT_WORKING_SEC,
  recentSec = DEFAULT_RECENT_SEC,
  providers: enabledIds,
  providerConfigs = {},
  configDir,
} = {}) {
  const now = Date.now();
  const rows = [];

  // 兼容旧调用：顶层 configDir 视为 claude 的配置
  const cfgs = { ...providerConfigs };
  if (configDir != null && cfgs.claude == null) cfgs.claude = { configDir };

  for (const p of activeProviders(enabledIds)) {
    const cfg = cfgs[p.id] || {};
    const sessions = safe(() => p.discover(cfg), null);
    if (!sessions) continue; // 单个 provider 挂了不影响其他

    for (const s of sessions) {
      const ageSec = (now - s.mtimeMs) / 1000;
      if (ageSec > recentSec) continue; // 只保留近 recentSec 内活动过的

      const meta = safe(() => p.parseMeta(s.file), { title: "(无标题)" });
      const sig = safe(() => p.parseActivity(s.file, s.size), { activity: "", done: false, waiting: false });
      const { state, activity } = classify({ ageSec, sig, workingSec });

      rows.push({
        provider: p.id,          // ← 来源标识（id，用于逻辑/过滤）
        providerLabel: p.label,  // ← 来源可读名（如 "Claude Code"，供前端直接展示，免查表）
        sid: s.sessionId,
        state,
        ageSec,
        activity,
        title: meta.title,
        project: s.project,
        mtime: new Date(s.mtimeMs),
      });
    }
  }

  rows.sort((a, b) => a.ageSec - b.ageSec); // 最活跃在最上（跨 provider 混排）
  return rows;
}

// ── 向后兼容导出 ─────────────────────────────────────
// 旧前端（electron/main.js、sessions.js）曾直接 import 这些。过渡期委托给 claude provider，
// 待 P3/P4 迁移完成后可移除。
import claude, { resolveProjectsRoot as _rpr } from "./providers/claude.js";

export const resolveProjectsRoot = _rpr;

// probeProjectsRoot(override) → 委托给 claude.probe（形状一致）
export function probeProjectsRoot(override) {
  return claude.probe({ configDir: override });
}
