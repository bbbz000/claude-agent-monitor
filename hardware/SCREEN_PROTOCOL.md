# 屏幕串口协议（PC ↔ ESP32-S3-RLCD-4.2）

PC 端 `hardware/screen-serial.js`（编码在 `hardware/screen-frame.js`）与固件 `firmware/rlcd-screen/rlcd-screen.ino` **共同遵守本文件**。改协议先改这里。

> 这是**独立于外设灯**的协议（灯用 `PROTOCOL.md` 的 `;` 分隔文本）。屏幕能显示的信息远比 4 颗灯多，故另设一套。

## 物理层

- **波特率**：`115200`
- **方向**：单向，PC → ESP32（ESP32 只读不回；可选启动时打印 `rlcd-screen ready`，PC 侧忽略）。
- **编码**：UTF-8 文本，**每帧一行 JSON**，行尾 `\n`（`0x0A`）。用 JSON 是因为会话标题/项目名含空格与中文，分隔符不安全；屏幕板 8MB PSRAM，ArduinoJson 解析开销可忽略。

## 帧格式

一帧 = 一行 JSON 对象 + `\n`。示例：

```json
{"t":"14:32","cpu":37,"mem":68,"total":8,"sessions":[{"st":"WORKING","ti":"重构扫描器","pj":"claude-agent-monitor","pv":"Claude Code","age":12,"w":false,"cx":42},{"st":"WAITING","ti":"改协议","pj":"foo","pv":"OpenCode","age":3,"w":true}]}
```

### 顶层字段

| 字段 | 类型 | 含义 |
|------|------|------|
| `t` | string | 时钟 `HH:MM`（PC 本地时间，最准）。空串=未知，固件显 `--:--` |
| `cpu` | int 0-100 | CPU 使用率百分比 |
| `mem` | int 0-100 | 内存使用率百分比 |
| `total` | int | 会话总数（可能 > `sessions` 长度，固件用来提示 `+N 更多`） |
| `act` | int 0/1 | 用户近期有输入活动（鼠标/键盘，PC 端 `powerMonitor.getSystemIdleTime()<10s`）。固件视同"有活跃会话"，用于从待机唤醒并维持不待机。省略/0=无活动 |
| `sessions` | array | 会话列表，已按 age 升序（最活跃在前，PC 已排好）。PC 截断到 `maxSessions` 条 |

### 单条会话（`sessions[]`）

| 字段 | 类型 | 含义 |
|------|------|------|
| `st` | string | 状态：`WORKING`/`WAITING`/`DONE`/`RECENT` |
| `ti` | string | 标题（PC 已截断到 ~28 全角字） |
| `pj` | string | 项目名（PC 已截断到 ~24 字） |
| `pv` | string | 来源可读名，如 `Claude Code` / `OpenCode` |
| `age` | int | 距今秒数 |
| `w` | bool | 是否等待你确认（`true` → 固件给该条画**闪烁边框**提醒） |
| `cx` | int 0-100 | 上下文占用率%（该会话已用掉的上下文窗口比例）。**仅 Claude 会话有**（PC 从 `.jsonl` 最后一条 assistant 的 `usage` 算出）；非 Claude 或读不到时**省略该字段**，固件不显示 |

### 清屏帧（off）

PC 断开/退出前发一帧，让屏幕别定格假状态：

```json
{"off":true}
```

固件收到后显示「已断开」提示（并仍刷新本地温湿度/电池，表明板子活着）。

## 状态 → 图标映射（单色屏用几何形区分，无颜色）

| state | 图标 | 画法 |
|-------|------|------|
| WORKING | ● 实心圆 | `drawDisc(r=4)` |
| WAITING | ▶ 三角 | `drawTriangle`（+ 条目边框闪烁） |
| DONE | ○ 空心圆 | `drawCircle(r=4)` |
| RECENT | · 小点 | `drawDisc(r=2)` |

## 数据来源划分（重要）

屏幕上并非所有信息都来自 PC：

| 信息 | 来源 | 说明 |
|------|------|------|
| 时钟 `t` | **PC**（帧内） | PC 时间最准 |
| `cpu`/`mem` | **PC**（帧内） | 主进程用 Node `os` 采样 |
| 会话列表 | **PC**（帧内） | `scan()` 结果 |
| 温度/湿度 | **固件本地** | 板载 SHTC3（I2C SDA=13/SCL=14），不经串口 |
| 电池电量 | **固件本地** | 板载 ADC1 CH3，不经串口 |

## 容错

- 固件对**畸形帧**（JSON 解析失败）整帧丢弃，保持上一帧，不闪。
- 行超长（> 2048 字节，异常）→ 固件丢弃该行防溢出。
- PC 侧 `state` 未知值仍原样下发，固件按 RECENT 的小点图标兜底渲染。

## 两块板同插的注意事项

LED 板（ESP32-C6）与屏幕板（ESP32-S3）USB VID 都是 `303a`，`SerialPort.list()` 无法只凭 VID 区分。若两块都要用：给**屏幕设备关掉「自动识别串口」并指定固定 COM 口**（托盘菜单 ▸ 屏幕 ▸ 取消自动识别；口在 `config.json` 的 `screen.port` 里填，如 `COM7`）。否则两者可能抢同一个口。
