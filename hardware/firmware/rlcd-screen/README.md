# ESP32-S3-RLCD-4.2 屏幕信息面板固件

把 `claude-agent-monitor` 的监控信息显示到微雪 **ESP32-S3-RLCD-4.2**（4.2" 300×400 反射式单色 LCD，ST7305）上。

```
 core/scanner.js scan() + os 指标  ──▶  electron 主进程  ──USB串口(JSON)──▶  ESP32-S3  ──▶  RLCD 面板
   (会话/CPU/内存/时钟)              hardware/screen-serial.js    115200        rlcd-screen.ino
```

## 屏幕布局（横屏 400×300）

```
┌─────────────────────────────────────────────┐
│ 14:32       23.5C 45%          ⚡ 87% [███░]  │  顶栏：时钟 · 温湿度 · 电池(图标)
├─────────────────────────────────────────────┤
│ CPU [████████░░░░░░░░]  37%                   │  指标带（PC 下发）
│ MEM [█████████████░░░]  68%                   │
├─────────────────────────────────────────────┤
│ ● 重构扫描器                                   │  会话列表
│   claude-agent-monitor · Claude Code · 12s    │
│ ▶ 改协议  ← WAITING，边框闪烁                   │
│   foo · OpenCode · 3s                         │
│ ...                              +2 更多      │
└─────────────────────────────────────────────┘
```

- 时钟 / CPU / 内存 / 会话列表：**PC 通过串口下发**。
- 温湿度（SHTC3）/ 电池电量（ADC）：**固件本地读**，不依赖 PC。
- 状态图标：● WORKING · ▶ WAITING（+闪烁边框）· ○ DONE · · RECENT。
- 电池：小电池图标（按电量填充）+ 百分比数字；**充电闪电 ⚡ 按「USB 在线」推断**——3s 内收到过 PC 数据帧即判在充电。本板有充电 IC 但未引出 CHG/PG 状态脚（官方仅引出 GPIO4 电池 ADC），故无法读真实充电信号；插墙充（不接 PC）时无帧、不显示闪电。

完整帧格式见 [`../../SCREEN_PROTOCOL.md`](../../SCREEN_PROTOCOL.md)。

## 引脚（微雪出厂定义，勿改）

| 功能 | 引脚 |
|------|------|
| LCD SPI | SCK=11 MOSI=12 DC=5 CS=40 RST=41 |
| SHTC3 I2C | SDA=13 SCL=14 |
| 电池 ADC | ADC1 CH3 |

三组互不冲突，可同时工作。

## 依赖库（Arduino IDE 库管理器）

- **U8g2**（单色图形；含中文字体 `u8g2_font_wqy12_t_gb2312`）
- **ArduinoJson**（**v7** 推荐；代码用 `JsonDocument` 弹性文档）

SHTC3 / ADC 用 Arduino-ESP32 core 自带的 ESP-IDF 驱动（`driver/i2c_master.h`、`esp_adc/*`），BSP 文件已随本目录附带，无需额外装库。
> 本固件时钟走 PC 下发，已删掉原示例的 PCF85063 RTC 部分，因此**不需要 SensorLib**。

## 烧录

1. Arduino IDE 装 **esp32 board 包**（3.0.0+）。
2. 开发板选 **ESP32S3 Dev Module**，按微雪 `Tools-Configuration.png`：
   - **PSRAM: OPI PSRAM**
   - **Flash Size: 16MB**
   - **USB CDC On Boot: Enabled**（关键！否则 `Serial` 收不到 PC 数据）
3. 打开 `rlcd-screen.ino`，选对 COM 口，上传。
   - 认不出口：按住 BOOT、点 RESET、松 BOOT 进下载模式。
4. 上传后串口监视器（115200）应看到 `rlcd-screen ready`，屏幕显示「等待 PC 连接…」+ 本地温湿度/电池。

## 连接 PC 端

在小条（`npm run bar` 或打包 exe）里：**托盘 ▸ 屏幕（ESP32-S3-RLCD）▸ 启用**。默认「自动识别串口」，插上即连。

> **两块板同插**（同时用 LED 灯板 + 屏幕板）：两者 USB VID 都是 `303a` 无法自动区分。给屏幕设备**取消「自动识别串口」**并在 `config.json` 的 `screen.port` 填固定口（如 `COM7`）。

## 离线自测（不接 PC）

串口监视器（115200，行尾 NL）手打一帧：

```json
{"t":"14:32","cpu":50,"mem":70,"total":2,"sessions":[{"st":"WAITING","ti":"测试标题","pj":"demo","pv":"Claude Code","age":5,"w":true}]}
```

屏幕应渲染三区，且该 WAITING 条目边框闪烁。发 `{"off":true}` 应显示「已断开」。
