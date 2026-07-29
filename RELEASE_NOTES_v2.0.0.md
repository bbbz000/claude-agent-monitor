## Claude Agent Monitor v2.0.0

实时监控本地 Claude Code / Desktop 的多 agent 会话状态 —— 直接扫描 `~/.claude/projects` 下的 `.jsonl` 文件判活，**无需 MCP、只读不写不上传**。

### ✨ 功能
- **两种前端**
  - 终端实时面板（`npm run monitor`）
  - 任务栏悬浮小条（Electron）：一个圆点 = 一个活跃 agent，颜色表状态
- **四种状态**：🟢 WORKING（运行中）/ 🟡 WAITING（等你确认）/ ✅ DONE（已回复）/ ⚪ RECENT（近期）
- **悬停详情**：鼠标移到圆点上弹气泡，显示对应 agent 的标题 / 项目 / 活动 / 时间
- **可配置数据目录**：自动识别 `CLAUDE_CONFIG_DIR` 环境变量，也可在设置面板手动指定 `.claude` 根目录（含「检测」按钮验证路径 + 统计会话数）
- **自由拖动**：托盘菜单开启后可把小条拖到屏幕任意位置并记住坐标
- **免安装 exe**：`npm run dist` 生成单文件 portable exe

### 📦 下载
- **`ClaudeAgentMonitor-2.0.0-portable.exe`** —— Windows 免安装绿色版，双击即用，无需装 Node，不写注册表。
- 想启动时不弹黑色控制台窗口：用 `scripts/start-bar-hidden.vbs`（源码运行时）。

### 🔧 从源码运行
```bash
npm install          # 仅小条版需要（终端版零依赖）
npm run bar          # 任务栏小条
npm run monitor      # 终端面板
npm run dist         # 打包成 exe
```

### 要求
- Node.js ≥ 18
- Windows（小条版基于 Electron，多屏/任务栏定位针对 Windows 优化）

---
🔒 隐私：本工具仅**读取**本地会话文件的修改时间与少量元数据用于判活，绝不修改、不联网上传。
