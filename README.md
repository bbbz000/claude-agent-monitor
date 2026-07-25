# Claude Agent Monitor

实时监控本地 **Claude Code / Claude Desktop agent 会话**的状态——在终端面板里看到当前有哪些 agent 正在运行、各自在忙什么，无需任何 MCP 配置或让 Claude 主动上报。

## 工作原理

Claude Code / Desktop 的每个 agent 会话都以 `.jsonl` 文件明文存在本地：

```
~/.claude/projects/<项目目录>/<sessionId>.jsonl
```

会话每产生一条消息，对应文件就被写入一次。本工具**纯靠扫描这些文件的修改时间（mtime）来判断 agent 是否活跃**——被动观测，零侵入，不依赖任何上报机制。

```
~/.claude/projects/**/*.jsonl  ──扫描 mtime──>  monitor.js（终端面板）
```

判活规则：

| 距最后修改 | 状态 | 含义 |
|-----------|------|------|
| < 30 秒 | ● WORKING | 正在运行 |
| 30 秒 ~ 5 分钟 | ◐ RECENT | 刚停下 |
| > 5 分钟 | （不显示） | 视为空闲 |

对 WORKING 的会话，还会读取文件尾部，区分当前处于 **AI 回复中 / 工具执行中 / 等待 AI**。

## 文件结构

```
claude-agent-monitor/
├── monitor.js      # 多 agent 实时终端面板（主程序）
├── sessions.js     # 列出全部历史 session
├── start.bat       # Windows 一键启动
├── package.json
└── README.md
```

## 使用

### 前置条件

- Node.js >= 18（仅用内置模块，**无第三方依赖，无需 npm install**）

### 启动实时监控面板

**Windows：** 双击 `start.bat`，或：

```bash
npm run monitor
```

面板每 2 秒刷新一次，`Ctrl+C` 退出。显示效果：

```
╔═══════════════════════════════════════════════════════════╗
║  Claude Agent Monitor          活跃 agent 实时状态         ║
╚═══════════════════════════════════════════════════════════╝
18:41:34   共 3 个近期活跃 · 1 个正在运行

● WORKING    2s前  claude-agent-monitor project overview
            70e89c0e  C:/Users/Administrator/Desktop/AI  AI 回复中
◐ RECENT     1m前  WorldMapMarchData performance test
            5b3b5b3a  C:/workspace/LDLProject/...
◐ RECENT     3m前  @Assets/.claude/commands/ai-review.md
            b4a6fa40  C:/workspace/LDLProject/...
```

每个 agent 一行，显示：状态、距上次活动的时间、会话标题、sessionId 前 8 位、所在项目路径、当前活动。

### 列出历史 session

```bash
npm run sessions              # 列出最近 30 个
node sessions.js --limit 50   # 指定数量
node sessions.js --json       # 输出 JSON（供程序 / 硬件消费）
node sessions.js --project LDL   # 按项目路径过滤
```

## 配置

在 `monitor.js` 顶部可调：

| 常量 | 默认 | 说明 |
|------|------|------|
| `WORKING_SEC` | 30 | 小于此秒数视为正在运行 |
| `RECENT_SEC` | 300 | 超过此秒数不再显示 |
| `REFRESH_MS` | 2000 | 面板刷新间隔（毫秒） |
| `MAX_ROWS` | 15 | 最多显示多少个 agent |

## 扩展：对接硬件 / 其他前端

核心是 `sessions.js` 导出的 `listSessions()` 与 `monitor.js` 内的 `scan()`——它们产出的都是**纯数据数组**。要接硬件（如外设指示灯）或做 Web 面板，无需改判活逻辑，只需在外层套一层输出，例如：

- **HTTP：** 加一个 `http.createServer`，`GET /agents` 返回 `JSON.stringify(scan())`，硬件轮询即可
- **串口 / USB：** 把 `scan()` 结果序列化后写串口，推给 MCU

## 说明

- 本工具只**读取**本地会话文件，不修改、不上传任何内容。
- 仅覆盖存在本地的 agent 会话（Claude Code / Desktop agent 模式）。claude.ai 普通网页对话的数据在服务器上，不在本工具范围内。
