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

1. Arduino IDE 装 **esp32 board 包**（Boards Manager 搜 "esp32"，需较新版本以支持 `ledcAttach`）。
2. 开发板选 **ESP32C6 Dev Module**（或 SuperMini 对应项）。
3. 打开 `firmware/agent-leds/agent-leds.ino`，选对 COM 口，点上传。
4. 打开串口监视器（115200），应看到 `READY`。手动发一帧测试：
   ```
   0,200,0;0,0,0;0,0,0;0,0,0
   ```
   LED0 应变绿，其余灭。

## 运行 PC 桥

桥需要 `serialport` 依赖（不在仓库默认依赖里，按需装）：

```bash
npm i serialport
```

无硬件先干跑（把要发的帧打到屏幕，验证状态映射）：

```bash
node hardware/bridge/serial-bridge.js --dry-run
```

查看可用串口：

```bash
node hardware/bridge/serial-bridge.js --list
```

正式推送（换成你的口）：

```bash
node hardware/bridge/serial-bridge.js --port COM3
```

也可 `npm run bridge -- --dry-run`。参数：`--port` 串口、`--baud`（默认 115200）、`--interval` 刷新毫秒（默认 2000）、`--dry-run`、`--list`。

## 与主项目的关系

- 本目录**不参与 Electron 打包**（`package.json` 的 `build.files` 白名单只含 `electron/`、`core/`、`package.json`），`npm run dist` 产物不含硬件文件。
- 桥只 `import` 现有 `scan()`，不改任何判活逻辑；固件不认识状态，只收 RGB。改判活规则仍只动 `core/`。
