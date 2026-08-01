// core/providers/registry.js
// 注册表：provider 的唯一真相源。加一个新客户端 = import + 往 ALL 加一项，别处不用动。
import claude from "./claude.js";
// import codex from "./codex.js";       // 将来
// import opencode from "./opencode.js"; // 将来

/** @type {import('./types.js').Provider[]} */
const ALL = [claude /*, codex, opencode */];

/**
 * 返回启用的 provider 列表。
 * 语义（与设置界面「全关」需求一致）：
 *   - enabledIds == null / undefined  → 全部启用（兼容旧 config、首次运行）
 *   - enabledIds == []（显式空数组）   → 一个都不启用（尊重用户「全关」）
 *   - 否则按 id 过滤，保留 ALL 的顺序
 */
export function activeProviders(enabledIds) {
  if (enabledIds == null) return ALL;
  return ALL.filter((p) => enabledIds.includes(p.id));
}

/** 全部 provider（含未启用）——供 sessions.js 遍历、probe 按 id 查找。 */
export function allProviders() {
  return ALL;
}

/** 供设置界面列出全部 provider（只要展示信息，不含解析逻辑）。 */
export function listMeta() {
  return ALL.map((p) => ({ id: p.id, label: p.label }));
}
