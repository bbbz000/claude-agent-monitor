# CPU_SHOW 硬件固件（初代 ESP32）

把 [CPU_SHOW](https://github.com/bbbz000/CPU_SHOW) 那块开发板（初代 ESP32 + CH9102 USB 串口 + 左右两组共阴 RGB LED + 两个 DAC 指针表头）改造成 Claude agent 状态显示器：

- **左灯 = agent1 状态，右灯 = agent2 状态**（颜色沿用本仓库状态映射）。
- **左表 = agent1 活跃度，右表 = agent2 活跃度**（DAC 指针，越活跃指针越偏，平滑扫动）。

数据来源与帧格式和主固件 `../agent-leds/` 完全一致，见 [../../PROTOCOL.md](../../PROTOCOL.md)。本板只有 2 颗灯，取帧的前 2 组。

## 与 C6 版（../agent-leds/）的区别

| 项 | 本固件（CPU_SHOW） | agent-leds（ESP32-C6） |
|---|---|---|
| 芯片 | 初代 ESP32（有 DAC） | ESP32-C6 |
| Arduino Core | 3.x（`ledcAttach`+`ledcWrite(引脚)`） | 3.x（同） |
| USB 串口 | 外置 CH9102（VID `1A86`） | 内置原生 USB（VID `303A`） |
| USB CDC On Boot | **不用开** | 必须开 |
| 灯数 | 2（左/右） | 4 |
| 引脚 | 左 5/18/19，右 13/12/14 | 见该目录 |

## 接线（沿用 CPU_SHOW 原固件）

共阴 RGB LED，公共脚接 GND，R/G/B 各串限流电阻（220~330Ω）后接 GPIO：

| LED | R | G | B |
|-----|---|---|---|
| 左灯（agent1） | GPIO5 | GPIO18 | GPIO19 |
| 右灯（agent2） | GPIO13 | GPIO12 | GPIO14 |

> 用的是共阳 LED？把 `.ino` 里 `COMMON_ANODE` 改为 `true`。

### 指针表头（DAC 直驱）

| 表 | GPIO | 含义 |
|----|------|------|
| 左表（agent1 活跃度） | GPIO26（DAC2） | 越活跃指针越偏 |
| 右表（agent2 活跃度） | GPIO25（DAC1） | 同上 |

- 量程 `METER_MIN=10 ~ METER_MAX=170`（DAC 8bit 值，对应指针静止端→满偏端），沿用原 CPU_SHOW 固件。
- **方向反装**：`.ino` 里 `METER_REVERSE = {true, false}`（默认左表反装、右表正装，同原固件）。
  自检时若某表“活跃反而回落”，翻对应项即可。
- 平滑：`METER_STEP` 控制指针每帧最大移动量，越小越缓。
- **休息护表**：反装的表空闲时指针反被顶在满偏端持续受力（恰是大部分时间）。故两表活跃度
  都为 0 持续满 `REST_AFTER_MS`（默认 **1 小时**，≈下班/夜里无活动）→ 进“休息”：两表 DAC 直接
  写 0（指针完全松开、不再受电压），停止刷新；白天一来活（任一活跃度 >0）立即唤醒平滑复位。
  想更早/更晚卸力就调 `REST_AFTER_MS`。

## 颜色含义

| 颜色 | 状态 | 动效 |
|------|------|------|
| 🟢 绿 | WORKING 正在运行 | 呼吸 |
| 🟠 橙 | WAITING 等你确认 | 快闪 |
| 🟡 黄 | RECENT 近期活动 | 常亮 |
| ⚫ 灭 | DONE / 无 agent | 灭 |

## 烧录

1. Arduino IDE 装 **esp32 board 包**（Boards Manager 搜 "esp32"）。
2. 开发板选 **ESP32 Dev Module**（初代 ESP32）。
3. **不需要** 开 USB CDC On Boot（本板走外置 CH9102，不是原生 USB）。
4. 打开 `cpushow-agent-leds.ino`，选 CPU_SHOW 所在的 COM 口（本机是 **COM10**），点上传。
5. 上电会跑一次自检：先左右两颗灯各自 红→绿→蓝 各亮 1 秒（确认接线和 R/G/B 顺序），
   再两个表头指针一起 静止端→满偏→回落 扫一遍（确认指针活着、行程与方向）。
6. 自检后手动发一帧测试（串口监视器 115200）：
   ```
   0,200,0;255,80,0;0,0,0;0,0,0|255,120,0,0
   ```
   左灯变绿（呼吸）、左表指针打高；右灯变橙（快闪）、右表指针中等。
   （`|` 后是各槽活跃度 0~255；不带 `|` 段也能跑，此时表头回静止端。）

## 点灯（PC 端）

烧完固件后，用主仓库的桥或小条，和 C6 版用法完全相同：

```bash
# 无硬件先干跑，看帧和状态映射
node hardware/bridge/serial-bridge.js --dry-run

# 实连（自动识别已支持 CH9102 的 VID 1A86，也可 --port 指定）
node hardware/bridge/serial-bridge.js --port COM10
```

小条（`npm run bar`）的托盘「外设灯」自动识别已把 `1A86`（CH9102/CH340）加进白名单，插上即连。

## 调试开关（`.ino` 顶部）

- `DEBUG_FORCE_ON true` —— 上电两灯白光常亮，不收串口，纯测硬件通路。测完改回 `false`。
- `COMMON_ANODE` —— 共阳 LED 改 `true`。
