# Claude Agent Monitor

实时监控本地 **AI Agent 会话**的状态，无需任何 MCP 配置或让 agent 主动上报。当前支持 **Claude Code / Desktop** 与 **OpenCode Desktop** 两种客户端，采用可扩展的 **provider 架构**——加一个新客户端 = 新增一个 provider 文件 + 注册表里加一行，前端与判活核心都不用动。提供两种前端：

- **终端面板**（`monitor.js`）：完整列表，看每个 agent 的标题、项目、当前活动。零依赖。
- **任务栏悬浮小条**（`electron/`）：贴在任务栏上的一排圆点，1 个圆点 = 1 个活跃 agent，颜色代表状态——像红绿灯，一眼扫过。需 Electron。

## 工作原理

本工具是**多数据源被动观测**：每个客户端由一个 **provider** 适配，各自去读该客户端在本地留下的痕迹，最后汇总成统一的会话状态（WORKING / WAITING / DONE / RECENT）。不同客户端把状态写在不同地方，判活方式也不同——但对上层前端完全透明。

### Claude Code / Desktop（读 `.jsonl` + mtime）

Claude 的每个 agent 会话都以 `.jsonl` 文件明文存在本地：

```
~/.claude/projects/<项目目录>/<sessionId>.jsonl
```

会话每产生一条消息，对应文件就被写入一次。所以**纯靠扫描这些文件的修改时间（mtime）来判断是否活跃**——被动观测，零侵入。

> 目录**自动适配**：默认扫 `~/.claude/projects`；若你用环境变量 `CLAUDE_CONFIG_DIR` 自定义过 Claude 数据位置，会自动跟随。也可在小条「设置…」里手动指定 `.claude` 根目录（见下）。

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

### OpenCode Desktop（读 `opencode.log`）

OpenCode 把会话存在一个 SQLite 库里，但那是**原子落库**——AI 正在思考/流式回复的那段时间，库里零写入、mtime 不动，轮询数据库根本抓不到「进行中」窗口（灯只会卡黄）。好在 OpenCode 的后台 server 会**实时把状态写进日志**：

```
~/.local/share/opencode/log/opencode.log
```

日志里每一轮工作的生命周期非常干净，本工具据此按 `session.id` 求每个会话**最后一条活动事件**判活：

| 日志事件 | 状态 | 含义 |
|------|------|------|
| `stream` / `loop` / `process` | ● WORKING | 正在生成 / 调工具 / 多步推进 |
| `exiting loop` | ✓ DONE | 本轮收尾 |

新鲜度（RECENT 判档）用**日志事件的时间戳**，因此流式期间日志一直在写、灯稳定变绿——这正是纯读数据库抓不到的窗口。

> **已知取舍**（纯日志方案的代价）：
> - 日志会滚动，**历史会话列表只覆盖日志窗口内出现过的会话**（不像 Claude 那样全量持久）。
> - 会话**真实标题**（聊天后生成、只写进数据库）不在日志里；窗口外的会话标题退化为**项目目录名**或占位。
> - 本版**不支持 WAITING**——OpenCode 日志无 `AskUserQuestion` 那种显式「等待用户」信号。
>
> 好处：**零原生依赖**（不需要 SQLite 驱动 / native rebuild）。默认日志路径自动检测，也可在设置里改 `logPath`。

## 文件结构

```
claude-agent-monitor/
├── core/
│   ├── scanner.js       # 判活核心：遍历各 provider、汇总统一状态（终端版与小条版共享）
│   ├── status.js        # 状态分档：把 provider 的原始信号映射为 WORKING/WAITING/DONE/RECENT
│   └── providers/       # 数据源适配器（每个客户端一个文件，纯 Node、零前端依赖）
│       ├── registry.js      # 注册表：provider 的唯一真相源（加客户端 = import + 加一行）
│       ├── claude.js        # Claude Code / Desktop：读 .jsonl + mtime
│       ├── opencode.js      # OpenCode Desktop：读 opencode.log
│       ├── _shared.js       # provider 间复用的只读小工具（读文件头/尾等）
│       └── types.js         # Provider / ConfigField 类型声明（JSDoc）
├── monitor.js      # 多 agent 实时终端面板
├── sessions.js     # 列出全部历史 session
├── electron/       # 任务栏悬浮小条（Electron）
│   ├── main.js         # 主进程：建窗 + 定时扫描 + 多屏定位 + 拖动 + 托盘菜单
│   ├── preload.cjs     # 安全桥（contextIsolation）
│   ├── renderer.*      # 小条 UI：画圆点 / 折叠 / 上色
│   ├── settings.*      # 设置窗口（取色器 + 阈值 + 各数据源配置，按 provider schema 自动渲染）
│   └── config.js       # 配置读写
├── scripts/            # 一键启动脚本
│   ├── start.bat            # 启动终端面板
│   ├── start-bar.bat        # 启动任务栏小条（首次会自动 npm install）
│   ├── start-bar-hidden.vbs # 无窗启动小条（不弹黑色控制台）
│   └── start-bar-debug.bat  # 诊断模式（看不见时用：亮底 + DevTools + 日志）
├── build/          # 打包资源（icon.png，electron-builder 自动转 .ico）
├── package.json
├── LICENSE
└── README.md
```

## 使用

### 前置条件

- **终端面板**：Node.js >= 18（仅用内置模块，**无第三方依赖，无需 npm install**）
- **任务栏小条**：额外需要 Electron（`scripts/start-bar.bat` 首次运行会自动 `npm install`）

> 所有 provider 都是**纯 Node、零运行时第三方依赖**（含 OpenCode——它读日志文本，不需要 SQLite 驱动或原生模块 rebuild）。`package.json` 的 `dependencies` 为空；Electron 仅作为小条的运行时/打包工具，列在 `devDependencies`。

### 启动实时监控面板

**Windows：** 双击 `scripts/start.bat`，或：

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

**Windows：** 双击 `scripts/start-bar.bat`（首次会自动 `npm install` 安装 Electron），或：

```bash
npm run bar
```

> 想启动时不弹黑色控制台窗口，改双击 `scripts/start-bar-hidden.vbs`（无窗启动，首装依赖也在后台静默进行）。

**拖动小条**：勾选托盘菜单的「自由拖动」后，用左键按住小条拖到屏幕任意位置即可；会记住坐标，下次启动回到原处。取消勾选「自由拖动」则跳回任务栏右下。

**菜单从托盘图标打开**（左键单击或右键托盘图标；小条本身右键已禁用，避免弹出 Windows 系统窗口菜单）：

- **自由拖动** —— 开关：勾选后可任意拖动小条并记住位置；取消勾选跳回任务栏右下
- **活跃阈值** —— 1 / 2 / 5 / 10 分钟（超过则不再显示）
- **设置…** —— 取色器自定义五种状态颜色、圆点上限、阈值、小条背景；以及**各数据源**（provider）的独立开关、路径填写与「检测」按钮（配置项由每个 provider 自己声明，界面自动渲染）
- **退出**

> ⚠️ 这是 Electron 的置顶悬浮窗「贴」在桌面/任务栏上，不是真正的任务栏嵌入（真嵌入需 C++ hack 任务栏窗口）。默认用**真透明窗**（胶囊只包住圆点、其余全透），并自动关闭 GPU 硬件合成——这是真透明窗在部分 Windows 上「整窗看不见」的根因，走软件合成路径后透明可靠生效。若仍看不见，可用 `scripts/start-bar.bat` 换 `--opaque` 退回不透明深色胶囊，或用 `scripts/start-bar-debug.bat` 诊断。小条会每 0.6s 自动重新置顶，防止任务栏抢层级把它盖住。设置存在 `%APPDATA%/claude-agent-monitor/config.json`。

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

**任务栏小条**：改托盘菜单「设置…」即可，或直接编辑 `%APPDATA%/claude-agent-monitor/config.json`：

| 字段 | 说明 |
|------|------|
| `providers` | 启用的 provider id 列表（如 `["claude","opencode"]`）；`null`=全部启用，`[]`=全关 |
| `providerConfigs` | 各 provider 各自的配置：`claude.configDir`（`.claude` 根覆盖，留空=自动检测 `CLAUDE_CONFIG_DIR` / 默认 `~/.claude`）、`opencode.logPath`（`opencode.log` 路径覆盖，留空=自动检测） |
| `displayId` / `position` / `freePos` / `offset` | 显示器、定位、自由拖动锚点 `{right,y}`、像素微调 |
| `colors` / `maxDots` / `barBackground` | 五种状态颜色、圆点上限、小条背景 |
| `workingSec` / `recentSec` / `refreshMs` | WORKING 阈值、RECENT 阈值、刷新间隔 |

## 扩展：对接硬件 / 其他前端

核心是 `core/scanner.js` 导出的 `scan()` 与 `sessions.js` 导出的 `listSessions()`——它们产出的都是**纯数据数组**（`scanner.js` 零副作用，可直接 `import { scan } from "./core/scanner.js"`）。要接硬件（如外设指示灯）或做 Web 面板，无需改判活逻辑，只需在外层套一层输出，例如：

- **HTTP：** 加一个 `http.createServer`，`GET /agents` 返回 `JSON.stringify(scan())`，硬件轮询即可
- **串口 / USB：** 把 `scan()` 结果序列化后写串口，推给 MCU

任务栏小条（`electron/main.js`）本身就是这个模式的一个实例：它 `import` 同一个 `scan()`，只把 `state` 数组推给渲染层。

### 加新 client（接一个新数据源）

判活核心（`core/status.js` 的 `classify()`）与两个前端都对 client **无感**——它们只吃统一的 `RawSignal`（`{ activity, done, waiting }`）。所以接一个新客户端只需两步：

1. 在 `core/providers/` 下新增一个文件，实现一个 **provider**：`discover(cfg)` 列出会话、`parseMeta` / `parseFullMeta` / `parseActivity` 解析标题与活动信号、`probe(cfg)` 供设置界面「检测」，外加一份 `configSchema`（声明式配置字段，设置界面据此自动渲染路径框/开关）。
2. 在 `core/providers/registry.js` 的 `ALL` 数组里加一行注册它。

**前端与判活核心一行都不用改**——OpenCode 正是照这个模式接进来的（`core/providers/opencode.js` + 注册表里一行）。

## 说明

- 本工具只**读取**本地会话文件，不修改、不上传任何内容。
- 覆盖各 provider 支持的本地会话（Claude Code / Desktop、OpenCode Desktop）。claude.ai 普通网页对话的数据在服务器上，不在本工具范围内。
