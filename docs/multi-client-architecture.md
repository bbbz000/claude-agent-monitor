# 多客户端架构重构设计

> 目标：让 Claude Agent Monitor 从"只监控 Claude Code/Desktop"演进为"可监控多种 agent 客户端"（未来可能是 OpenCode、Codex 等），**且加一个新客户端 = 新增一个文件 + 注册一行**，不碰核心编排、不碰任何前端。
>
> 本文只做**架构设计**，不预设具体接入哪个客户端。Codex/OpenCode 的真实文件格式待有实际会话文件后再补。

> **一等需求：多客户端并发同屏。** 本地同时跑 Claude 1 个任务 + OpenCode 1 个任务时，必须**同时显示 2 个灯**（小条 2 个圆点 / 终端 2 行），各自带来源标识。这不是特例——见 §2.5，它是编排器"多 provider 汇总到一个列表"的自然结果。

---

## 1. 现状：Claude 假设散落在何处

现有分层**方向是对的**——`core/scanner.js` 是纯逻辑，三个前端（`monitor.js` / `sessions.js` / `electron/main.js`）共享同一个 `scan()`。问题在于**抽象边界画错了**：`scan()` 同时承担了「扫哪里」和「怎么解析」两件事，而这两件事对每个客户端都不同。

Claude 专属假设的分布（全部集中在 `core/scanner.js` 与 `sessions.js`）：

| 层 | 位置 | Claude 专属之处 |
|----|------|----------------|
| **路径发现** | `resolveBase()` `resolveProjectsRoot()` | 写死 `~/.claude`、`CLAUDE_CONFIG_DIR`、`projects/` 子目录 |
| **目录布局** | `scan()` 双层遍历、`decodeProject()` | 写死"projects 根 → 项目目录 → `<sid>.jsonl`"两层结构；`C--Users--` 目录编码是 Claude 独有 |
| **文件格式** | `readTail()` / `readHead()` + `.jsonl` 后缀 | 写死按行 JSON、`.jsonl` 后缀 |
| **会话 schema（判活核心）** | `getActivity()` | 依赖 `o.type==="assistant"`、`o.message.stop_reason`、`tool_result` 结构 |
| **标题解析** | `getMeta()` | 依赖 `custom-title`/`ai-title`/`queue-operation` 等 Claude 专属行类型 |
| **等待判定** | `WAITING_TOOLS` | `AskUserQuestion`/`ExitPlanMode` 是 Claude 工具名 |
| **活动细分** | `toolActivity()` | `Bash`/`Read`/`Edit`… 是 Claude 工具名 |
| **文案/命名** | monitor.js、sessions.js、README、tray 标题 | 到处 "Claude" 字样 |

**结论**：需要变动。把"扫哪里 + 怎么解析"从 `scan()` 里抽出来，做成**客户端适配器（provider）**。`scan()` 退化为纯编排器：遍历已启用的 provider → 让 provider 吐出归一化的会话状态 → 统一做 WORKING/WAITING/DONE/RECENT 分档。

---

## 2. 目标架构：Provider 适配器模式

```
core/
  scanner.js            # 编排器：遍历 providers → 收集归一化 state → 统一分档/排序
  status.js             # 纯函数：把 provider 的原始信号 → WORKING/WAITING/DONE/RECENT（与 provider 无关）
  providers/
    types.js            # Provider 接口约定 + 归一化数据结构（JSDoc typedef）
    registry.js         # 注册表：列出/启用/解析 provider（按 id）
    claude.js           # Claude 适配器（迁移现有逻辑）
    codex.js            # 将来：Codex 适配器（本次不实现）
    opencode.js         # 将来：OpenCode 适配器（本次不实现）
    _shared.js          # provider 间可复用的小工具（readHead/readTail/extractText 等）
```

前端（monitor / sessions / electron）**几乎不用改**：`scan()` 的返回契约保持向后兼容，只**新增**字段（见 §4）。

### 2.1 Provider 接口

每个 provider 是一个对象，实现下述接口（用 JSDoc 约定，不引入 TS）。核心思想：**provider 只负责"发现文件 + 把一个会话文件解析成客户端无关的原始信号"，绝不自己判 WORKING/RECENT**——分档由 `core/status.js` 统一做，保证各客户端口径一致。

```js
/**
 * @typedef {Object} DiscoveredSession
 * @property {string} file        会话文件绝对路径
 * @property {string} sessionId   会话唯一 id（provider 内唯一即可）
 * @property {string} project     可读的项目/工作目录路径（已解码）
 * @property {number} mtimeMs     文件修改时间（provider 直接给，避免重复 stat）
 * @property {number} size        文件字节数
 */

/**
 * @typedef {Object} RawSignal   provider 从会话内容读出的"客户端无关"原始信号
 * @property {string} activity    人话活动描述（"执行命令"/"AI 回复中"…），可空
 * @property {boolean} done        本轮是否已结束（AI 回复完 end_turn 等）
 * @property {boolean} waiting     是否在等用户确认/回答（阻塞式，不受时间影响）
 */

/**
 * @typedef {Object} Provider
 * @property {string}  id          稳定标识，如 "claude" / "codex"
 * @property {string}  label       展示名，如 "Claude Code"
 * @property {(cfg: ProviderConfig) => DiscoveredSession[]} discover
 *           发现该客户端所有"近期可能活跃"的会话文件（自己解析目录布局）
 * @property {(file: string) => { title: string }} parseMeta
 *           读文件头拿标题（带缓存交给 provider 自己管，因格式各异）
 * @property {(file: string, size: number) => RawSignal} parseActivity
 *           读文件尾推断当前活动 + done/waiting
 * @property {(cfg: ProviderConfig) => ProbeResult} [probe]
 *           可选：设置界面"检测路径"用，返回 {root, exists, sessionCount, error}
 */
```

`ProviderConfig` 是从全局 config 里切给该 provider 的那一份（见 §5），例如 Claude 的 `{ configDir }`，Codex 可能是 `{ homeDir }` 之类。provider 之间互不知道彼此的配置形状。

### 2.2 注册表 `registry.js`

```js
import claude from "./claude.js";
// import codex from "./codex.js";     // 将来
// import opencode from "./opencode.js";

const ALL = [claude /*, codex, opencode */];

/** 返回启用的 provider 列表。enabled 缺省=全部启用（向后兼容旧 config）。 */
export function activeProviders(enabledIds /*: string[] | undefined */) {
  if (!enabledIds || !enabledIds.length) return ALL;
  return ALL.filter((p) => enabledIds.includes(p.id));
}

export function allProviders() { return ALL; }
```

加新客户端 = 写 `providers/codex.js` + 在 `ALL` 里加一项。**没有别的地方要动。**

### 2.3 编排器 `scanner.js`（重构后）

`scan()` 变薄，逻辑与具体客户端彻底解耦：

```js
import { activeProviders } from "./providers/registry.js";
import { classify } from "./status.js";

export function scan({ workingSec, recentSec, providers: enabledIds, providerConfigs = {} } = {}) {
  const now = Date.now();
  const rows = [];
  for (const p of activeProviders(enabledIds)) {
    const cfg = providerConfigs[p.id] || {};
    let sessions;
    try { sessions = p.discover(cfg); } catch { continue; }  // 单个 provider 挂了不影响其他

    for (const s of sessions) {
      const ageSec = (now - s.mtimeMs) / 1000;
      if (ageSec > recentSec) continue;

      const meta = safe(() => p.parseMeta(s.file), { title: "(无标题)" });
      const sig  = safe(() => p.parseActivity(s.file, s.size), { activity: "", done: false, waiting: false });

      const { state, activity } = classify({ ageSec, sig, workingSec });  // 统一分档
      rows.push({
        provider: p.id,            // ← 新增字段
        sid: s.sessionId, state, ageSec, activity,
        title: meta.title, project: s.project, mtime: new Date(s.mtimeMs),
      });
    }
  }
  rows.sort((a, b) => a.ageSec - b.ageSec);
  return rows;
}
```

`core/status.js` 收纳原来 `scan()` 尾部那段 if/else 分档（WAITING > WORKING > DONE > RECENT），**它不认识任何 provider**，只吃 `{ageSec, sig, workingSec}`。这样口径对所有客户端统一，未来调判活规则只改一处。

### 2.4 Claude provider `providers/claude.js`

把现有 `resolveBase`/`resolveProjectsRoot`/`probeProjectsRoot`/`decodeProject`/`getMeta`/`getActivity`/`toolActivity`/`WAITING_TOOLS` 原样搬进来，包成 provider 对象导出。**逻辑一行不改**，只是换了个家 + 实现统一接口。风险极低。

### 2.5 多客户端并发同屏（一等需求）

**"同时显示多个客户端的灯"不是需要额外实现的特性，而是 §2.3 编排器的直接产物。** 关键在于 `scan()` 把所有 provider 的活跃会话**汇进同一个扁平 `rows` 数组**，每行带自己的 `provider` 标记：

```
Claude provider.discover()   → [会话A]  ─┐
OpenCode provider.discover() → [会话B]  ─┼─→  rows = [ {provider:"claude", …A}, {provider:"opencode", …B} ]
Codex provider.discover()    → []       ─┘        ↑ 2 行 = 小条 2 个灯 = 终端 2 行
```

所以本地 Claude 1 个 + OpenCode 1 个 → `rows` 2 行 → **小条 2 个圆点、终端面板 2 行**，天然并存。没有"主客户端"概念，provider 之间完全对等；某个客户端没有活跃会话就贡献 0 行，不占位。

**排序**：现有逻辑按 `ageSec` 升序（最活跃在最前），跨 provider 一起排——即混合排列，谁刚动过谁在前，来源无关。这通常最符合直觉（一眼看到"最新在动的是谁"）。若将来想**按来源分组**（所有 Claude 灯排一起、再排 OpenCode），只是 `rows.sort()` 换个比较函数 + 前端分段，属前端表现层，不影响核心。

**前端如何区分同屏不同来源的灯** —— 这是唯一需要新增的前端工作，见 §4。核心链路（scan 汇总 → 推给渲染）不变。

---

## 3. sessions.js 的处理

`sessions.js`（历史 session 列表）目前自带一套和 scanner 重复的 `readHead`/`extractText`/`decodeProject`/`parseSession`。重构时：

- 让它也走 provider：`listSessions()` 遍历 `allProviders()`，用每个 provider 的 `discover()` + `parseMeta()`（+ provider 可选提供一个 `parseFullMeta()` 拿 cwd/gitBranch/startTime 这些额外字段）。
- 消除与 scanner 的重复代码，`_shared.js` 收纳 `readHead`/`extractText`。
- CLI 输出多一列 provider 来源（`[claude]` / `[codex]`）。

> 若想控制改动面，本次可**只重构 scanner + electron 链路**，`sessions.js` 保持独立留到下一轮——但那会留一份重复的 Claude 解析逻辑。建议一起做，量不大。

---

## 4. 前端改动（很小，向后兼容）

`scan()` 返回的行**新增 `provider` 字段**（值为 provider id，如 `"claude"`）。前端据此显示来源。

**同屏区分来源的方式：仅 hover / 文字**（已定）。灯本身保持全圆点不变——**形状与颜色两个维度都不用于区分来源**，颜色继续只编码状态。来源只在悬停气泡和文字行里出现。理由：小条视觉最干净、改动最小、零破坏；代价是不悬停时同屏两个同色灯看不出各自来源（可接受）。

- **electron 小条**：圆点渲染**完全不变**（颜色=状态，全圆点）。只在 **hover 气泡**里加一行来源，如 `Claude Code · <标题>` / `OpenCode · <标题>`。需要把 `provider` 随 `lastRows` 一起带到 hover 详情（`main.js` 已缓存 `lastRows` 供 hover 查详情，加个字段即可）。核心链路（`main.js` 调 `scan()` → 推 state 给渲染层）**零改动**。provider id → 展示名的映射用 registry 里各 provider 的 `label`。
- **monitor.js（终端面板）**：每行加来源标，如在标题前置 `[Claude]` / `[OpenCode]`（用 `provider` 的 `label`）。标题栏文案从"Claude Agent Monitor"改成中性名（如"Agent Monitor"）。
- **sessions CLI**：每行多一列来源 `[claude]` / `[opencode]`。

**关键**：`provider` 是新增字段，老前端代码读不到它也不报错，是纯增量；小条圆点样式一行不改。

---

## 5. 配置演进（config.json）

现有 `configDir`（Claude 的 .claude 覆盖）需要泛化，但要**向后兼容旧 config**：

```jsonc
{
  // 新增：启用哪些 provider（缺省/空 = 全部启用）
  "providers": ["claude"],

  // 新增：每个 provider 各自的配置，形状由 provider 自己定义
  "providerConfigs": {
    "claude": { "configDir": "" },          // 迁移自旧的顶层 configDir
    "codex":  { "homeDir": "" }             // 将来
  },

  // ……其余（colors/maxDots/workingSec/refreshMs/position…）不变……
}
```

**迁移逻辑**（在 `electron/config.js` 的 `mergeDefaults` 里做）：老 config 若有顶层 `configDir` 且没有 `providerConfigs`，自动搬到 `providerConfigs.claude.configDir`。用户无感。

### 5.1 设置界面：列出所有 provider，可逐个开关

**需求**：设置面板里有一个「数据源」分区，**列出注册表中全部 provider**，每个一行，带一个启用/停用开关；停用的 provider 不参与扫描（不出灯）。每个 provider 还能各自填路径覆盖 + 点「检测」。这样用户能自主决定"我只想看 Claude"或"Claude + OpenCode 都看"。

**这块和核心架构咬合得很自然**——registry 已经是 provider 的唯一真相源，UI 只是把它渲染成一排开关，把结果写回 `config.providers`。

#### 数据流

```
registry.listMeta()                       main.js 打开设置时，把 provider 元信息
  → [{id,label}, …]              ──────►   连同 config 一起 send("settings:init")
                                              │
settings.html/js 动态渲染「数据源」分区 ◄──────┘
  每个 provider 一行：[✓开关] label  [路径覆盖框] [检测按钮] [检测结果]
                                              │
用户勾选/取消 + 填路径 → 保存 ──────────────►  settings:save 回传
  { providers:["claude","opencode"],           main.js 落盘 config → 下次 scan()
    providerConfigs:{claude:{configDir},…} }    只遍历 config.providers 里启用的
```

#### registry 增补一个元信息导出

UI 要列出"所有 provider"（含未启用的），所以 registry 除了 `activeProviders()` 再导出：

```js
/** 供设置界面列出全部 provider（不含解析逻辑，只要展示信息）。 */
export function listMeta() {
  return ALL.map((p) => ({ id: p.id, label: p.label }));
}
```

#### probe 泛化为按 provider

现有 `settings:probe` IPC 只认 Claude 的 configDir。泛化成带 provider id：

```js
// preload.cjs
probe: (providerId, providerCfg) => ipcRenderer.invoke("settings:probe", providerId, providerCfg),

// main.js
ipcMain.handle("settings:probe", (_e, providerId, providerCfg) => {
  const p = allProviders().find((x) => x.id === providerId);
  if (!p || typeof p.probe !== "function") return null;   // 该 provider 没实现 probe
  return p.probe(providerCfg || {});
});
```

每个 provider 的 `probe()` 返回统一形状 `{root, source, exists, isDir, sessionCount, error}`（Claude 现成的 `probeProjectsRoot` 直接搬进 `claude.provider.probe`），`renderProbe()` 逻辑不用改，对任何 provider 通用。

#### settings.html / settings.js 改动

- **html**：把当前写死的「数据目录」分区（只有 Claude 一个输入框）换成一个空容器 `<div id="providers">`，由 js 按 `listMeta()` **动态生成**每行（开关 + label + 路径框 + 检测按钮 + 结果行）。这样将来加 provider，设置界面自动多一行，**settings.html 不用再改**。
- **js**：`init(config, providerMeta)` 里遍历 `providerMeta` 建行；开关状态读 `config.providers`（不在数组里=停用；数组缺省/空=全部启用，与 registry 语义一致）；路径框读 `config.providerConfigs[id]`。保存时收集所有勾选的 id → `providers`，各路径 → `providerConfigs`。
- **防注入**：provider 的 `label`/路径仍全程 `textContent`，沿用现有 `span()` 约定，绝不 `innerHTML` 拼。

#### 至少保留一个启用的兜底

若用户把所有 provider 都关了，`activeProviders([])` 现有语义是"空数组=全部启用"（向后兼容老 config）。这会造成"我全关了反而全开"的反直觉。解决：区分"未配置(undefined)"与"显式空([])"——
- config 里 `providers` **缺字段/undefined** → 全部启用（兼容旧 config、首次运行）；
- `providers: []` **显式空数组** → 一个都不扫（尊重用户"全关"）。

`activeProviders` 相应改为 `if (enabledIds == null) return ALL;`（只在 null/undefined 时回退全开）。设置界面在用户全关时给一句提示"已停用所有数据源，不会显示任何灯"，避免误操作。

---

## 6. 分阶段落地

| 阶段 | 内容 | 破坏性 | 可独立交付 |
|------|------|--------|-----------|
| **P1 抽象骨架** | 建 `providers/{types,registry,claude,_shared}.js` + `status.js`；`scan()` 改为编排器；Claude 逻辑原样迁入 | 无（对外契约不变，仅新增 `provider` 字段） | ✅ 跑通即可发 |
| **P2 收编 sessions.js** | `sessions.js` 走 provider，消除重复解析 | 无 | ✅ |
| **P3 配置泛化 + provider 开关 UI** | config 加 `providers`/`providerConfigs` + 旧配置迁移；registry 加 `listMeta()`；设置界面「数据源」分区**动态列出全部 provider，每个可开关 + 各自路径覆盖 + 检测**；probe 泛化为按 provider；全关兜底提示 | 无（自动迁移） | ✅ |
| **P4 前端来源标识** | monitor/小条/CLI 显示 provider 来源；中性化命名与文案 | 无 | ✅ |
| **P5 接第一个新客户端** | 有真实会话文件后，写 `codex.js` 或 `opencode.js` + 注册一行 | 无（纯新增） | ✅ 到时再做 |

P1–P4 都不依赖"确定接哪个客户端"，现在就能做，做完架构即"可扩展"。P5 等你定了目标客户端、拿到真实会话文件再动，届时**只写一个 provider 文件**。

---

## 7. 关键设计取舍

- **provider 只出原始信号，不判档**：WORKING/RECENT 等状态分档留在 `status.js` 统一做。否则每个 provider 各判各的，阈值口径会漂移，也难统一调。
- **不引入 TypeScript / 插件热加载**：保持"零/极少依赖"的项目气质。provider 是静态 import 的普通对象，用 JSDoc 约定接口足够；将来真需要第三方插件再谈动态加载。
- **向后兼容优先**：`scan()` 契约只增不改；旧 config 自动迁移。任何一步都能单独发布、不破坏现有用户。
- **单 provider 失败隔离**：一个 provider 的 `discover/parse` 抛错只跳过它自己，不拖垮整个扫描。
- **命名中性化**：项目/产品名去 "Claude" 化（如"Agent Monitor"），但仓库名、Claude provider 内部仍保留 Claude 字样——它就是 Claude 适配器。
