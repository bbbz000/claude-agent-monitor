# 硬件：ESP32-C6 SuperMini 状态灯

用 4 颗独立 RGB LED 实时显示本地 Claude agent 会话状态：一颗灯 = 一个活跃 agent，颜色 = 状态。数据来自本仓库判活核心 `core/scanner.js` 的 `scan()`，经 USB 串口推给 ESP32。

```
 core/scanner.js scan()  ──▶  bridge/serial-bridge.js  ──USB串口──▶  ESP32-C6  ──▶  4×RGB LED
     (判活核心，共用)          (状态→RGB→帧，本目录)      115200        agent-leds.ino
```

## 颜色含义

| 颜色 | 状态 | 含义 |
|------|------|------|
| 🟢 绿 | WORKING | 正在运行 |
| 🟠 橙 | WAITING | 等你确认/回答 |
| 🔵 青 | DONE | 本轮已回复 |
| 🟡 黄 | RECENT | 近期活动过 |
| ⚫ 灭 | —— | 该槽无 agent |

最活跃的 agent 在 LED0。超过 4 个 agent 不显示（4 颗灯上限）。完整帧格式与映射见 [PROTOCOL.md](PROTOCOL.md)。

## 接线（4 颗共阴 RGB LED → 12 个 GPIO）

每颗 RGB LED 4 个脚：公共脚 + R/G/B。**共阴**接法：公共脚 → GND，R/G/B 各**串一个限流电阻（220~330Ω）**后接对应 GPIO。

固件默认引脚（见 `firmware/agent-leds/agent-leds.ino` 顶部 `LED_PINS`，已避开 strapping GPIO8/9/15 与 USB GPIO12/13）：

| LED | R | G | B |
|-----|---|---|---|
| LED0 | GPIO0 | GPIO1 | GPIO2 |
| LED1 | GPIO3 | GPIO4 | GPIO5 |
| LED2 | GPIO6 | GPIO7 | GPIO10 |
| LED3 | GPIO18 | GPIO19 | GPIO20 |

> 用的是**共阳** LED（公共脚接 3V3）？把 `.ino` 里 `COMMON_ANODE` 改为 `true`。
> 引脚和你的接线不同？直接改 `LED_PINS` 表。

## 烧录固件

1. Arduino IDE 装 **esp32 board 包**（Boards Manager 搜 "esp32"，需 3.0.0+ 以支持 C6 和 `ledcAttach`）。
2. 开发板选 **ESP32C6 Dev Module**（或 "MakerGO ESP32 C6 SuperMini" 若有）。
3. **Tools ▸ USB CDC On Boot ▸ Enabled**（关键！C6 靠内置 USB-Serial 通信，不开这个 `Serial` 收不到任何数据、灯不会亮）。
4. 打开 `firmware/agent-leds/agent-leds.ino`，选对 COM 口，点上传。
   - 首次烧录若认不出口：按住 BOOT、点一下 RESET、松开 BOOT 进下载模式。
5. 打开串口监视器（115200），应看到 `READY`。手动发一帧测试：
   ```
   0,200,0;0,0,0;0,0,0;0,0,0
   ```
   LED0 应变绿，其余灭。

## 点灯的两种方式

### 方式 A：任务栏小条内置（推荐，另一台电脑双击即用）

Electron 小条已内置外设灯功能，打包进 exe。用法：

1. 运行小条（`npm run bar`，或直接双击打包好的 `ClaudeAgentMonitor-*-portable.exe`）。
2. **托盘图标 ▸ 外设灯（ESP32）▸ 启用**（默认「自动识别串口」已开）。
3. 插上 ESP32 → 自动按 USB VID(`303A`) 找到它并连接、点灯；拔了不崩，再插自动重连。

菜单里有一行只读状态显示当前连接情况（`已连接 COMx` / `未连接（等待设备）` / `serialport 未安装`）。

> 打包版把 `serialport` 及其原生二进制一并打进 exe（`build.asarUnpack` 解包 `.node`），所以目标电脑**无需装 Node/serialport**，插上就用。ESP32-C6 走原生 USB-CDC，Win10/11 多数免驱。

### 方式 B：独立命令行桥（调试 / 无小条时用）

桥需要 `serialport` 依赖：

```bash
npm i serialport
```

无硬件先干跑（把要发的帧打到屏幕，验证状态映射）：

```bash
node hardware/bridge/serial-bridge.js --dry-run
```

查看可用串口 / 正式推送（换成你的口）：

```bash
node hardware/bridge/serial-bridge.js --list
node hardware/bridge/serial-bridge.js --port COM3
```

也可 `npm run bridge -- --dry-run`。参数：`--port`、`--baud`（默认 115200）、`--interval`（默认 2000）、`--dry-run`、`--list`。

## 与主项目的关系

- 状态→RGB→帧的映射是**唯一真相源** `hardware/led-frame.js`，小条主进程与独立桥共用，改颜色只改这一处。
- 小条主进程通过 `hardware/led-serial.js` 用串口；serialport 用动态 `import`，**缺库/未启用时静默降级，绝不影响小条本体**。
- 打包只收 `hardware/led-frame.js` + `hardware/led-serial.js`（exe 用到的）；固件 `.ino`、独立桥、本文档不入 exe。
- 判活逻辑仍只在 `core/`；固件不认识状态，只收 RGB。
