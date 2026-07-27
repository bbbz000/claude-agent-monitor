# Claude Agent Monitor

实时监控本地 **Claude Code / Claude Desktop agent 会话**的状态，无需任何 MCP 配置或让 Claude 主动上报。提供两种前端：

- **终端面板**（`monitor.js`）：完整列表，看每个 agent 的标题、项目、当前活动。零依赖。
- **任务栏悬浮小条**（`electron/`）：贴在任务栏上的一排圆点，1 个圆点 = 1 个活跃 agent，颜色代表状态——像红绿灯，一眼扫过。需 Electron。

## 工作原理

Claude Code / Desktop 的每个 agent 会话都以 `.jsonl` 文件明文存在本地：

```
~/.claude/projects/<项目目录>/<sessionId>.jsonl
```

会话每产生一条消息，对应文件就被写入一次。本工具**纯靠扫描这些文件的修改时间（mtime）来判断 agent 是否活跃**——被动观测，零侵入，不依赖任何上报机制。

> 目录**自动适配**：默认扫 `~/.claude/projects`；若你用环境变量 `CLAUDE_CONFIG_DIR` 自定义过 Claude 数据位置，会自动跟随。也可在小条「设置…」里手动指定 `.claude` 根目录（见下）。

```
~/.claude/projects/**/*.jsonl  ──扫描 mtime──>  monitor.js（终端面板）
```

判活规则：先按文件修改时间（mtime）分档，再读文件尾部最后一条记录细分状态。

| 判据 | 状态 | 含义 |
|------|------|------|
| 尾部是 `AskUserQuestion` / 退出计划模式 | ◆ WAITING | **AI 停下等你确认/回答**（不受时间影响，可能等很久） |
| < 30 秒内动过、本轮未结束 | ● WORKING | 正在运行 |
| 尾部是 `end_turn` 等 | ✓ DONE | 本轮已回复 |
| 30 秒 ~ 5 分钟 | ◐ RECENT | 刚停下 |
| > 5 分钟 | （不显示） | 视为空闲 |

对运行中的会话，还会按文件尾部细分当前活动：**执行命令 / 读取搜索 / 写文件 / 联网 / 子任务 / AI 回复中 / 工具执行中 / 等待 AI**。

> WAITING（等你确认）依据的是 `AskUserQuestion` 和退出计划模式这类**会写进 .jsonl** 的“等待用户”工具。Claude Code 的**权限弹窗**（“是否允许运行此命令”）不写文件，从 mtime 无法区分，故不覆盖。

## 文件结构

```
claude-agent-monitor/
├── core/
│   └── scanner.js  # 判活核心：扫描 .jsonl、推断状态（终端版与小条版共享）
├── monitor.js      # 多 agent 实时终端面板
├── sessions.js     # 列出全部历史 session
├── electron/       # 任务栏悬浮小条（Electron）
│   ├── main.js         # 主进程：建窗 + 定时扫描 + 多屏定位 + 拖动 + 托盘菜单
│   ├── preload.cjs     # 安全桥（contextIsolation）
│   ├── renderer.*      # 小条 UI：画圆点 / 折叠 / 上色
│   ├── settings.*      # 设置窗口（取色器 + 阈值）
│   └── config.js       # 配置读写
├── start.bat           # 一键启动终端面板
├── start-bar.bat       # 一键启动任务栏小条（首次会自动 npm install）
├── start-bar-debug.bat # 诊断模式启动小条（看不见时用：亮底 + DevTools + 日志）
├── package.json
└── README.md
```

## 使用

### 前置条件

- **终端面板**：Node.js >= 18（仅用内置模块，**无第三方依赖，无需 npm install**）
- **任务栏小条**：额外需要 Electron（`start-bar.bat` 首次运行会自动 `npm install`）

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

### 任务栏悬浮小条

贴在任务栏上的一排圆点，每个圆点是一个活跃 agent，颜色代表状态：

| 颜色（默认） | 状态 | 含义 |
|------------|------|------|
| 🟢 绿 | WORKING | 正在运行（会呼吸闪烁） |
| 🟠 橙红 | WAITING | 等你确认/回答（急促闪烁提示“需要你”） |
| 🔵 青 | DONE | 本轮已回复 |
| 🟡 黄 | RECENT | 近期活动过 |
| ⚫ 灰 | EMPTY | 无活跃 agent 时的占位点 |

圆点超过上限（默认 12）折叠成 `…+N`。所有颜色都可在设置里改（想要单色就把几个状态设成同色）。

小条宽度**随圆点数量自适应**：几个 agent 就多宽，最少保留 1 个圆点单位（无活跃时=1 个灰点）。伸缩以**右边缘为锚**——圆点变多向左长、变少向右收，右边缘始终不动，贴任务栏右下时最自然。

**Windows：** 双击 `start-bar.bat`（首次会自动 `npm install` 安装 Electron），或：

```bash
npm run bar
```

**拖动小条**：勾选托盘菜单的「自由拖动」后，用左键按住小条拖到屏幕任意位置即可；会记住坐标，下次启动回到原处。取消勾选「自由拖动」则跳回任务栏右下。

**菜单从托盘图标打开**（左键单击或右键托盘图标；小条本身右键已禁用，避免弹出 Windows 系统窗口菜单）：

- **自由拖动** —— 开关：勾选后可任意拖动小条并记住位置；取消勾选跳回任务栏右下
- **活跃阈值** —— 1 / 2 / 5 / 10 分钟（超过则不再显示）
- **设置…** —— 取色器自定义五种状态颜色、圆点上限、阈值、数据目录、小条背景
- **退出**

> ⚠️ 这是 Electron 的置顶悬浮窗「贴」在桌面/任务栏上，不是真正的任务栏嵌入（真嵌入需 C++ hack 任务栏窗口）。默认用**真透明窗**（胶囊只包住圆点、其余全透），并自动关闭 GPU 硬件合成——这是真透明窗在部分 Windows 上「整窗看不见」的根因，走软件合成路径后透明可靠生效。若仍看不见，可用 `start-bar.bat` 换 `--opaque` 退回不透明深色胶囊，或用 `start-bar-debug.bat` 诊断。小条会每 0.6s 自动重新置顶，防止任务栏抢层级把它盖住。设置存在 `%APPDATA%/claude-agent-monitor/config.json`。

### 打包成 exe（免安装绿色版）

想分发给没装 Node 的人，可打包成单文件免安装 exe（内置 Electron 运行时，双击即用）：

```bash
npm run dist
```

产物在 `dist/ClaudeAgentMonitor-<版本>-portable.exe`（约 70MB）。拷给别人双击即可运行，无需安装、不写注册表。图标源文件在 `build/icon.png`（256×256，electron-builder 打包时自动转成 Windows 所需的多尺寸 `.ico`）。

> 打包用 [electron-builder](https://www.electron.build/)（已在 devDependencies）。配置见 `package.json` 的 `build` 字段：`portable` target、`files` 白名单只含 `electron/`、`core/`、`package.json`（终端版脚本、`.bat`/`.vbs` 启动器不入包）。`dist/` 已在 `.gitignore`，产物不入库。首次打包会下载 Electron 及 NSIS 等打包资源。

### 列出历史 session

```bash
npm run sessions              # 列出最近 30 个
node sessions.js --limit 50   # 指定数量
node sessions.js --json       # 输出 JSON（供程序 / 硬件消费）
node sessions.js --project LDL   # 按项目路径过滤
```

## 配置

**终端面板**：在 `monitor.js` 顶部可调：

| 常量 | 默认 | 说明 |
|------|------|------|
| `WORKING_SEC` | 30 | 小于此秒数视为正在运行 |
| `RECENT_SEC` | 300 | 超过此秒数不再显示 |
| `REFRESH_MS` | 2000 | 面板刷新间隔（毫秒） |
| `MAX_ROWS` | 15 | 最多显示多少个 agent |

**任务栏小条**：改托盘菜单「设置…」即可，或直接编辑 `%APPDATA%/claude-agent-monitor/config.json`（`displayId` / `configDir`（Claude `.claude` 根目录覆盖，留空=自动检测 `CLAUDE_CONFIG_DIR` / 默认 `~/.claude`）/ `position` / `freePos`（自由拖动锚点 `{right,y}`，右边缘+顶边）/ `offset` / `colors` / `maxDots` / `workingSec` / `recentSec` / `barBackground` / `refreshMs`）。

## 扩展：对接硬件 / 其他前端

核心是 `core/scanner.js` 导出的 `scan()` 与 `sessions.js` 导出的 `listSessions()`——它们产出的都是**纯数据数组**（`scanner.js` 零副作用，可直接 `import { scan } from "./core/scanner.js"`）。要接硬件（如外设指示灯）或做 Web 面板，无需改判活逻辑，只需在外层套一层输出，例如：

- **HTTP：** 加一个 `http.createServer`，`GET /agents` 返回 `JSON.stringify(scan())`，硬件轮询即可
- **串口 / USB：** 把 `scan()` 结果序列化后写串口，推给 MCU

任务栏小条（`electron/main.js`）本身就是这个模式的一个实例：它 `import` 同一个 `scan()`，只把 `state` 数组推给渲染层。

## 说明

- 本工具只**读取**本地会话文件，不修改、不上传任何内容。
- 仅覆盖存在本地的 agent 会话（Claude Code / Desktop agent 模式）。claude.ai 普通网页对话的数据在服务器上，不在本工具范围内。
