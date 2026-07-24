# Claude Agent Monitor

一个基于 MCP（Model Context Protocol）的 Claude Desktop Agent 状态监控工具。通过在终端实时显示 Claude 的工作状态（Working / Idle），让你随时掌握 Agent 是否正在处理任务。

## 工作原理

```
Claude Desktop  ──MCP──>  server.js  ──写入──>  status.json  <──监听──  watch.js（终端面板）
```

1. `server.js` 作为 MCP Server 运行，向 Claude Desktop 暴露 `task_start` 和 `task_end` 两个工具
2. Claude 在处理用户请求时调用这些工具，状态被写入 `status.json`
3. `watch.js` 监听文件变化，在终端实时显示状态更新
4. 如果 5 分钟内无活动，自动切换为 idle 状态

## 文件结构

```
claude-agent-monitor/
├── server.js        # MCP Server，提供 task_start / task_end 工具
├── watch.js         # 终端 Watcher，实时显示状态
├── install.js       # 安装脚本，自动注册到 Claude Desktop 配置
├── status.json      # 状态文件（运行时自动生成/更新）
├── package.json
└── node_modules/
```

## 安装与使用

### 前置条件

- Node.js >= 18
- Claude Desktop 已安装

### 步骤

1. **安装依赖**

```bash
npm install
```

2. **注册 MCP Server 到 Claude Desktop**

```bash
npm run install-config
```

该命令会自动将 `agent-monitor` 写入 Claude Desktop 的配置文件：
`%APPDATA%\Claude\claude_desktop_config.json`

3. **重启 Claude Desktop**

4. **启动终端监控面板**

```bash
npm run watch
```

5. **（推荐）添加 Custom Instructions**

在 Claude Desktop 的 Settings > Custom Instructions 中添加：

> Every time you begin processing a user request, call the task_start tool first. When you finish, call task_end.

这样 Claude 会在每次处理请求时自动调用状态上报工具。

## MCP 工具说明

| 工具 | 说明 | 参数 |
|------|------|------|
| `task_start` | 任务开始时调用，状态变为 "working" | `description` — 任务简要描述 |
| `task_end` | 任务结束时调用，状态变为 "idle" | `summary` — 完成内容摘要 |

## 终端显示效果

```
╔══════════════════════════════════════╗
║   Claude Agent Monitor - Watcher    ║
╚══════════════════════════════════════╝

[12:00:01] ○ IDLE     MCP Server started, waiting for tasks
[12:00:15] ● WORKING  分析用户提交的代码并给出优化建议
[12:01:02] ○ IDLE     已完成代码分析，给出了 3 条优化建议
```

## status.json 格式

```json
{
  "state": "working",
  "message": "当前任务描述",
  "time": "2026-07-24T04:02:17.664Z"
}
```

| 字段 | 说明 |
|------|------|
| `state` | `"working"` 或 `"idle"` |
| `message` | 任务描述或完成摘要 |
| `time` | ISO 8601 时间戳 |

## npm scripts

| 命令 | 说明 |
|------|------|
| `npm start` | 启动 MCP Server（通常由 Claude Desktop 自动调用） |
| `npm run watch` | 启动终端状态监控面板 |
| `npm run install-config` | 将 MCP Server 注册到 Claude Desktop 配置 |

## 技术栈

- **MCP SDK** — `@modelcontextprotocol/sdk ^1.12.1`
- **运行时** — Node.js（ESM）
- **状态持久化** — 文件系统（`status.json`）
- **文件监听** — `fs.watch`（Node.js 原生）
