// core/providers/types.js
// Provider 接口约定 + 归一化数据结构（仅 JSDoc typedef，无运行时代码）。
// 每个客户端适配器（claude.js / 将来的 codex.js / opencode.js）都实现下述 Provider 接口。
//
// 设计原则：provider 只负责「发现会话文件」+「把一个会话文件解析成客户端无关的原始信号」，
// 绝不自己判 WORKING/RECENT——状态分档由 core/status.js 统一做，保证各客户端口径一致。

/**
 * @typedef {Object} DiscoveredSession   provider 发现的一个会话文件
 * @property {string} file        会话文件绝对路径
 * @property {string} sessionId   会话唯一 id（provider 内唯一即可）
 * @property {string} project     可读的项目/工作目录路径（已解码）
 * @property {string} [projectKey] 可选：provider 内部的原始项目标识（如 Claude 的编码目录名）。
 *           仅供过滤等按内部键匹配用；展示一律用 project。
 * @property {number} mtimeMs     文件修改时间（provider 直接给，避免上层重复 stat）
 * @property {number} size        文件字节数
 */

/**
 * @typedef {Object} RawSignal    provider 从会话内容读出的「客户端无关」原始信号
 * @property {string}  activity   人话活动描述（"执行命令"/"AI 回复中"…），可空
 * @property {boolean} done       本轮是否已结束（AI 回复完 end_turn 等）
 * @property {boolean} waiting    是否在等用户确认/回答（阻塞式，不受时间影响）
 */

/**
 * @typedef {Object} SessionMeta
 * @property {string} title       会话标题
 */

/**
 * @typedef {Object} FullMeta     历史列表用的完整元信息（parseFullMeta 返回）
 * @property {string} title
 * @property {string} firstMsg    首条用户消息（截断显示用）
 * @property {string} cwd         工作目录
 * @property {string} gitBranch   git 分支
 * @property {string} startTime   首条消息时间戳（ISO）
 */

/**
 * @typedef {Object} ConfigField  provider 声明的一个配置字段（设置界面据此通用渲染控件）。
 *           provider 只描述「我要什么」，不关心「长什么样、怎么渲染」——渲染在 electron/settings.js。
 * @property {string} key          存进 providerConfigs[id] 的键名，如 "configDir" / "apiKey"
 * @property {"path"|"text"|"secret"|"select"} type  控件类型：路径框/文本框/密码框/下拉
 * @property {string} [label]      字段标签（纯文本，textContent 渲染）
 * @property {string} [placeholder] 输入占位符
 * @property {{value:string,label:string}[]} [options] type==="select" 时的选项
 */

/**
 * @typedef {Object} ProbeResult  设置界面「检测」用；各 provider 返回统一形状
 * @property {string}  root       解析出的会话根目录绝对路径
 * @property {string}  source     路径来源标记（"manual"/"env"/"default" 等，provider 自定义）
 * @property {boolean} exists
 * @property {boolean} isDir
 * @property {number}  sessionCount
 * @property {?string} error
 */

/**
 * @typedef {Object} Provider
 * @property {string}  id           稳定标识，如 "claude" / "codex"
 * @property {string}  label        展示名，如 "Claude Code"
 * @property {ConfigField[]} [configSchema]
 *           可选：该 provider 需要哪些配置字段。设置界面遍历它按 type 通用渲染控件。
 *           未声明 → 该 provider 无可配置项（只有启用开关）。provider 各字段值存于
 *           config.providerConfigs[id]，检测时整包传给 probe(cfg)。
 * @property {(cfg: Object) => DiscoveredSession[]} discover
 *           发现该客户端所有会话文件（自己解析目录布局）。cfg 是从全局 config 切给该 provider 的那份。
 * @property {(file: string) => SessionMeta} parseMeta
 *           读文件头拿标题（缓存由 provider 自己管，因格式各异）
 * @property {(file: string) => FullMeta} [parseFullMeta]
 *           可选：读文件头拿历史列表所需的完整元信息（title + cwd/gitBranch/startTime/firstMsg）。
 *           sessions.js 用；未实现则退回 parseMeta（只有 title）。
 * @property {(file: string, size: number) => RawSignal} parseActivity
 *           读文件尾推断当前活动 + done/waiting
 * @property {(cfg: Object) => ProbeResult} [probe]
 *           可选：设置界面「检测路径」用
 */

export {}; // 纯类型模块，无导出实体
