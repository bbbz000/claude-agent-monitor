// rlcd-screen.ino
// ESP32-S3-RLCD-4.2（微雪 4.2" 300x400 反射式单色 LCD，ST7305）Agent Monitor 信息面板固件。
//
// 从 PC 端 claude-agent-monitor 经串口收「每帧一行 JSON」，渲染成三区面板：
//   顶栏     ：时钟(PC 下发) · 温湿度(本地 SHTC3) · 电池%(本地 ADC)
//   指标带   ：CPU% / 内存%（PC 下发，带百分比条）
//   会话列表 ：状态图标 + 标题 + 项目·来源·age；整条按会话状态 st 反显，WAITING（提问）正反显闪烁
//
// 协议真相源见 ../../SCREEN_PROTOCOL.md。
//
// 依赖库（Arduino IDE 库管理器安装）：
//   - U8g2（单色图形，含 wqy16 中文字体）
//   - ArduinoJson（v6/v7 皆可）
// SHTC3/ADC 用板载 ESP-IDF 驱动（Arduino-ESP32 core 自带），已随本目录附带 BSP 文件。
//
// 板卡设置见微雪 Tools-Configuration：Board=ESP32S3 Dev Module, PSRAM=OPI PSRAM,
// Flash=16MB, USB CDC On Boot=Enabled（这样 Serial 走原生 USB）。

#include <math.h>            // fabsf / lroundf（进度条缓动用）
#include <ArduinoJson.h>
#include "ST7305_U8g2.h"
#include "i2c_bsp.h"
#include "i2c_equipment.h"
#include "adc_bsp.h"

// ── 屏幕（横屏 400x300）───────────────────────────────
#define LCD_W 400
#define LCD_H 300
#define RLCD_SCK_PIN  11
#define RLCD_MOSI_PIN 12
#define RLCD_DC_PIN   5
#define RLCD_CS_PIN   40
#define RLCD_RST_PIN  41

static ST7305_U8g2 lcd(RLCD_SCK_PIN, RLCD_MOSI_PIN, RLCD_DC_PIN, RLCD_CS_PIN, RLCD_RST_PIN);
static U8G2 *u8g2 = nullptr;

// ── I2C 温湿度（SHTC3，SCL=14 SDA=13 port=0）───────────
static I2cMasterBus i2cBus(14, 13, 0);
static Shtc3Port *shtc3 = nullptr;

// ── 串口接收缓冲（按行）────────────────────────────────
static const size_t FRAME_LINE_MAX = 2048;  // 注意别用 LINE_MAX：那是 limits.h 的系统宏，会冲突
static char lineBuf[FRAME_LINE_MAX];
static size_t lineLen = 0;

// ── 面板状态（最近一帧解析结果）─────────────────────────
struct Session {
  char st[10];   // 状态
  char ti[96];   // 标题（UTF-8，中文占 3 字节，96 够 ~28 全角字 + 余量）
  char pj[80];   // 项目
  char pv[32];   // 来源
  int  age;      // 秒
  bool waiting;  // 是否等待确认（协议 w 字段）。注：反显现按 st 判定，本字段解析后暂未在渲染中读取
  int  ctx;      // 上下文占用%（0..100）；-1=未知（非 Claude/PC 省略了 cx 字段）→ 不显示
  int  life;     // 剩余存活%（0..100）＝消失倒计时；-1=PC 未下发 lf → 不画（正常恒有值）
};
static const int MAX_SESS = 8;

static char   g_clock[8] = "";     // PC 下发时钟 HH:MM
static int    g_cpu = 0;           // 目标值（PC 下发的最新采样）
static int    g_mem = 0;
static float  g_cpuShown = 0;      // 屏上"当前显示值"，每帧朝目标缓动，数据 1s 一跳时条也平滑滑过去
static float  g_memShown = 0;
static float  g_cpuShownSlow = 0;  // "慢条"显示值：缓动系数更小、追得更慢，画在快条底层做半透明拖影
static float  g_memShownSlow = 0;
static int    g_total = 0;         // 会话总数（可能 > 显示条数）
static Session g_sess[MAX_SESS];
static int    g_sessCount = 0;
static bool   g_off = false;       // PC 要求清屏（off 帧）

// 本地传感器读数（固件自采，不依赖 PC）
static float  g_temp = 0, g_humi = 0;
static bool   g_thValid = false;
static int    g_batt = 0;
static uint32_t g_lastSensorMs = 0;
static uint32_t g_lastRenderMs = 0;  // 渲染节流时间戳（用 millis 节流，不用 delay 阻塞串口）
static uint32_t g_lastFrameMs = 0;   // 最近一次收到「数据帧」的时刻。用于推断 USB 在线=充电中：
                                     // 帧在持续到达 ⇒ 屏幕 USB 接着 PC ⇒ VBUS 供电 ⇒ 电池在充。

// 是否至少收到过一帧（没收到就显示等待提示）
static bool   g_gotFrame = false;

// ── 待机（无活跃会话超时）─────────────────────────────────
// 帧里有 WORKING/WAITING 会话即视为「活跃」，刷新 g_lastActiveMs。
// 连续 IDLE_MS 没有活跃会话 → 进待机：只显大时钟+温湿度/电池，低频刷新、内容微移防残影。
// WAITING 也算活跃，故待确认的会话永远不会被待机藏起来。串口照常读，一有活动秒级唤醒。
static const uint32_t IDLE_MS = 15UL * 60 * 1000; // 空闲多久进待机（15 分钟；改这里即可调）
static uint32_t g_lastActiveMs = 0;              // 最近一次「有活跃会话」的时刻（0=从未活跃过）
static bool     g_standby = false;               // 当前是否待机（用于状态跳变时强制立即重绘）

// ── 复制字符串到定长缓冲（截断 + 补 0）───────────────────
static void copyStr(char *dst, size_t cap, const char *src) {
  if (!src) { dst[0] = 0; return; }
  size_t i = 0;
  for (; src[i] && i < cap - 1; i++) dst[i] = src[i];
  dst[i] = 0;
}

// ── 解析一行 JSON 帧 → 更新面板状态 ──────────────────────
static void parseFrame(const char *json, size_t len) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json, len);
  if (err) return; // 畸形帧整帧丢弃，保持上一帧（与 LED 协议容错一致）

  if (doc["off"].as<bool>()) { g_off = true; g_gotFrame = true; return; }
  g_off = false;
  g_gotFrame = true;
  g_lastFrameMs = millis();  // 收到真实数据帧 ⇒ USB 接着 PC ⇒ 判定在充电（见 g_lastFrameMs 注释）
  if (g_lastActiveMs == 0) g_lastActiveMs = g_lastFrameMs;  // 首帧起算待机倒计时：
      // 让"连上就全是空闲会话"也先完整显示 IDLE_MS 的仪表盘再入睡，而不是一连上就待机。

  copyStr(g_clock, sizeof(g_clock), doc["t"] | "");
  g_cpu = doc["cpu"] | 0;
  g_mem = doc["mem"] | 0;
  g_total = doc["total"] | 0;

  // act=1：PC 端检测到用户近期有输入（鼠标移动/点击/键盘）。等同于"有活跃会话"，
  // 用来把屏幕从待机唤醒、并在你用电脑期间维持不待机。
  bool anyActive = (doc["act"] | 0) != 0;
  g_sessCount = 0;
  JsonArrayConst arr = doc["sessions"].as<JsonArrayConst>();
  for (JsonObjectConst s : arr) {
    if (g_sessCount >= MAX_SESS) break;
    Session &d = g_sess[g_sessCount];
    copyStr(d.st, sizeof(d.st), s["st"] | "");
    copyStr(d.ti, sizeof(d.ti), s["ti"] | "");
    copyStr(d.pj, sizeof(d.pj), s["pj"] | "");
    copyStr(d.pv, sizeof(d.pv), s["pv"] | "");
    d.age = s["age"] | 0;
    d.waiting = s["w"] | false;
    d.ctx = s["cx"] | -1;   // PC 省略 cx（非 Claude/读不到）→ -1，渲染时不显示
    d.life = s["lf"] | -1;  // 剩余存活%＝消失倒计时；PC 恒下发，-1 仅作兜底不画
    if (!strcmp(d.st, "WORKING") || !strcmp(d.st, "WAITING")) anyActive = true;
    g_sessCount++;
  }
  if (anyActive) g_lastActiveMs = millis();  // 有活干 → 刷新活跃时刻，重置待机倒计时
}

// ── 串口收数：逐字节拼行，遇 \n 解析一帧 ──────────────────
static void pumpSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      lineBuf[lineLen] = 0;
      if (lineLen > 0) parseFrame(lineBuf, lineLen);
      lineLen = 0;
    } else if (c != '\r') {
      if (lineLen < FRAME_LINE_MAX - 1) lineBuf[lineLen++] = c;
      else lineLen = 0; // 行超长（异常）→ 丢弃，防溢出
    }
  }
}

// ── 本地传感器采样（~2s 一次，避免拖慢渲染）──────────────
static void sampleSensors() {
  uint32_t now = millis();
  if (g_lastSensorMs != 0 && (now - g_lastSensorMs) < 2000) return;
  g_lastSensorMs = now;
  if (shtc3) {
    float t, h;
    if (shtc3->Shtc3_ReadTempHumi(&t, &h) == 0) {
      g_temp = t; g_humi = h; g_thValid = true;
    }
  }
  g_batt = Adc_GetBatteryLevel();
}

// ── 绘图辅助 ────────────────────────────────────────────
static void drawRightStr(int xRight, int y, const char *s) {
  int w = u8g2->getUTF8Width(s);
  u8g2->drawUTF8(xRight - w, y, s);
}

// 棋盘点阵填一个矩形：隔一个像素点亮一个。单色屏没有真正的 alpha，
// 这种 50% 抖动在反射屏上肉眼看就是一片"半透明灰"，用来当慢条的底影。
static void drawHalftoneBox(int x, int y, int w, int h) {
  for (int j = 0; j < h; j++)
    for (int i = 0; i < w; i++)
      if (((x + i) + (y + j)) & 1) u8g2->drawPixel(x + i, y + j);
}

// 画一个 0..100 的百分比条（label 在左，条在右）。
// pct 是"快条"（实心，跟得紧）；pctSlow 是"慢条"（点阵半透明，追得慢）。
// 慢条先画在底层：值骤降时它作为拖影留在快条右侧，值骤升时快条实心尖端探出到它前面，
// 两条错位就是肉眼可见的"惯性差"。
static void drawBar(int x, int y, int w, int h, int pct, int pctSlow, const char *label) {
  u8g2->setFont(u8g2_font_8x13_tf);      // 放大：标签/百分比用 8x13
  u8g2->drawStr(x, y + h - 3, label);
  int labelW = 40;                       // "CPU"/"MEM"（8x13 约 24px）+ 间隔
  int bx = x + labelW;
  int bw = w - labelW - 46;              // 右侧留 46px 显 "100%"（8x13）
  if (bw < 10) bw = 10;
  u8g2->drawFrame(bx, y, bw, h);
  int inner = bw - 2;
  int fill     = inner * (pct     < 0 ? 0 : pct     > 100 ? 100 : pct)     / 100;
  int fillSlow = inner * (pctSlow < 0 ? 0 : pctSlow > 100 ? 100 : pctSlow) / 100;
  if (fillSlow > 0) drawHalftoneBox(bx + 1, y + 1, fillSlow, h - 2); // 底层：慢条点阵
  if (fill > 0)     u8g2->drawBox(bx + 1, y + 1, fill, h - 2);       // 上层：快条实心
  char pctStr[8];
  snprintf(pctStr, sizeof(pctStr), "%d%%", pct);
  u8g2->drawStr(bx + bw + 5, y + h - 3, pctStr);
}

// 每条会话下的「上下文占用」细条：纯实心填充（不像 CPU/MEM 那样有快/慢拖影——
// ctx 是每帧一个定值，无惯性可言）。条在左，百分比数字紧贴条右侧。
// 调用方需保证 pct>=0（-1=未知的会话不画本条）。
static void drawCtxBar(int x, int y, int w, int h, int pct) {
  int p = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  u8g2->drawFrame(x, y, w, h);
  int inner = w - 2;
  int fill = inner * p / 100;
  if (fill > 0) u8g2->drawBox(x + 1, y + 1, fill, h - 2);
  char s[8];
  snprintf(s, sizeof(s), "%d%%", p);
  u8g2->setFont(u8g2_font_6x10_tf);      // 小字号，别和会话文字抢高度
  u8g2->drawStr(x + w + 6, y + h, s);    // 数字贴条右侧，基线约与条底对齐
}

// 每条会话的「剩余存活」条＝消失倒计时：本条超过 recentSec 未活动就会从列表消失，
// 满=刚活动过、空=即将消失。画在 ctx 条右侧、同一行（不占额外垂直空间），
// 用点阵半透明填充（drawHalftoneBox）与实心的 ctx 条区分开——点阵的"淡"也正好呼应"正在消退"。
// 不画百分比数字：同一行已有 ctx 的数字，再加一个易混；条本身足够表达倒计时。
// 调用方需保证 pct>=0（-1=PC 未下发，不画）。
static void drawLifeBar(int x, int y, int w, int h, int pct) {
  int p = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  u8g2->drawFrame(x, y, w, h);
  int inner = w - 2;
  int fill = inner * p / 100;
  if (fill > 0) drawHalftoneBox(x + 1, y + 1, fill, h - 2);
}

// 状态图标：用简单几何形区分（单色屏无颜色）
//   WORKING ●(实心) / WAITING ▶(三角，闪) / DONE ○(空心) / RECENT ·(小点)
static void drawStateIcon(int cx, int cy, const char *st) {
  if (!strcmp(st, "WORKING"))      u8g2->drawDisc(cx, cy, 6);
  else if (!strcmp(st, "WAITING")) u8g2->drawTriangle(cx - 6, cy - 6, cx - 6, cy + 6, cx + 6, cy);
  else if (!strcmp(st, "DONE"))    u8g2->drawCircle(cx, cy, 6);
  else                              u8g2->drawDisc(cx, cy, 3); // RECENT / 其它
}

// 小电池图标：外框 + 右侧凸头（正极）+ 按电量比例横向填充。(x,y)=电池"身体"左上角。
// 单色屏无法用颜色表低电，仅用填充长度表示；数字百分比放在图标左侧给精度。
static void drawBatteryGlyph(int x, int y, int bw, int bh, int pct) {
  u8g2->drawFrame(x, y, bw, bh);                       // 身体外框
  int nubH = bh / 2;                                    // 右侧凸头
  u8g2->drawBox(x + bw, y + (bh - nubH) / 2, 3, nubH);
  int p = pct < 0 ? 0 : pct > 100 ? 100 : pct;          // 内部填充（夹在 0..100）
  int innerW = bw - 4;
  int fill = innerW * p / 100;
  if (fill > 0) u8g2->drawBox(x + 2, y + 2, fill, bh - 4);
}

// 充电闪电（约 8x14），(x,y)=左上角。两个实心三角拼出锯齿，单色屏也清晰。
static void drawBolt(int x, int y) {
  u8g2->drawTriangle(x + 5, y,     x + 1, y + 8, x + 5, y + 8);
  u8g2->drawTriangle(x + 3, y + 6, x + 7, y + 6, x + 3, y + 14);
}

// ── 待机画面 ────────────────────────────────────────────
// 无活跃会话超时后显示：大时钟居中 + 温湿度/电池一行 + 右下"待机"小字。
// 低频刷新（loop 里降到 ~20s 一次），内容按分钟在 ±3px 内微移，长期常显不积残影。
// 右下角"待机"二字是刻意留的：让你一眼区分"是待机"还是"又卡死了"（有过卡死前科）。
static void renderStandby() {
  u8g2->clearBuffer();
  u8g2->setDrawColor(1);

  // 防残影微移：整屏在 ±3px 内缓慢漂移，各轴换位周期错开（3min / 3.5min），避免像素长期常亮。
  int ox = (int)((millis() / 180000UL) % 7) - 3;
  int oy = (int)((millis() / 210000UL) % 7) - 3;

  // 大时钟（logisoso32 数字体，含冒号）。若该字体未随库编入导致编译报错，改用 u8g2_font_10x20_tf。
  u8g2->setFont(u8g2_font_logisoso32_tn);
  const char *clk = g_clock[0] ? g_clock : "--:--";
  int cw = u8g2->getStrWidth(clk);
  u8g2->drawStr((LCD_W - cw) / 2 + ox, 158 + oy, clk);

  // 温湿度 + 电池一行（证明板子活着、传感器在读）
  char line[48];
  snprintf(line, sizeof(line), "%.1fC %.0f%%RH   BAT %d%%", g_temp, g_humi, g_batt);
  u8g2->setFont(u8g2_font_8x13_tf);
  int lw = u8g2->getStrWidth(line);
  u8g2->drawStr((LCD_W - lw) / 2 + ox, 196 + oy, line);

  // 右下"待机"小字
  u8g2->setFont(u8g2_font_wqy16_t_gb2312);
  drawRightStr(LCD_W - 4 + ox, LCD_H - 6 + oy, "待机");

  u8g2->sendBuffer();
}

// ── 渲染整屏 ────────────────────────────────────────────
static void render() {
  u8g2->clearBuffer();
  u8g2->setDrawColor(1);

  // 未收到任何帧：提示等待
  if (!g_gotFrame || g_off) {
    u8g2->setFont(u8g2_font_wqy16_t_gb2312);
    const char *msg = g_off ? "已断开" : "等待 PC 连接…";
    int w = u8g2->getUTF8Width(msg);
    u8g2->drawUTF8((LCD_W - w) / 2, LCD_H / 2, msg);
    // 即便没帧也显示本地温湿度/电池，证明板子活着
    char line[48];
    snprintf(line, sizeof(line), "%.1fC  %.0f%%RH  BAT %d%%", g_temp, g_humi, g_batt);
    u8g2->setFont(u8g2_font_8x13_tf);
    int lw = u8g2->getStrWidth(line);
    u8g2->drawStr((LCD_W - lw) / 2, LCD_H / 2 + 26, line);
    u8g2->sendBuffer();
    return;
  }

  // ── 顶栏 y=0..24 ──
  // 左：时钟（放大到 10x20）
  u8g2->setFont(u8g2_font_10x20_tf);
  u8g2->drawStr(2, 19, g_clock[0] ? g_clock : "--:--");
  // 中：温湿度
  char th[32];
  if (g_thValid) snprintf(th, sizeof(th), "%.1fC %.0f%%", g_temp, g_humi);
  else           snprintf(th, sizeof(th), "--C --%%");
  u8g2->setFont(u8g2_font_8x13_tf);
  int thw = u8g2->getStrWidth(th);
  u8g2->drawStr((LCD_W - thw) / 2, 18, th);
  // 右：电池图标 + 百分比（+ 充电闪电）。从最右往左排：[电池][ 87%][⚡]
  // 充电判定：3s 内收到过数据帧 ⇒ USB 接着 PC ⇒ 在充电（无硬件充电脚，只能这样推断）。
  bool charging = (g_lastFrameMs != 0) && (millis() - g_lastFrameMs < 3000);
  const int battW = 26, battH = 14;            // 电池身体尺寸（含右侧 3px 凸头，实占 29px）
  int bx = LCD_W - 2 - (battW + 3);            // 电池身体左上角 x（顶到最右，留 3px 凸头空间）
  int by = 18 - battH + 1;                     // 与 8x13 文字基线对齐
  drawBatteryGlyph(bx, by, battW, battH, g_batt);
  char batPct[8];
  snprintf(batPct, sizeof(batPct), "%d%%", g_batt);
  u8g2->setFont(u8g2_font_8x13_tf);
  int pw = u8g2->getStrWidth(batPct);
  u8g2->drawStr(bx - 4 - pw, 18, batPct);      // 百分比在电池左侧
  if (charging) drawBolt(bx - 4 - pw - 10, by); // 闪电在百分比左侧
  u8g2->drawHLine(0, 25, LCD_W);

  // ── 指标带 y=28..76（放大条高 18）──
  // 缓动：每帧朝目标滑 ~30%（~8fps 下约 0.5s 到位），差 <0.5 直接吸附，避免无限逼近。
  // 数据 1s 一跳，但条长/百分比逐帧平滑滑过去，观感连续（近似 TrafficMonitor）。
  g_cpuShown += (g_cpu - g_cpuShown) * 0.3f;
  g_memShown += (g_mem - g_memShown) * 0.3f;
  if (fabsf(g_cpu - g_cpuShown) < 0.5f) g_cpuShown = g_cpu;
  if (fabsf(g_mem - g_memShown) < 0.5f) g_memShown = g_mem;
  // 慢条：上升时追上快条即吸附齐平；下降时以"固定速度"匀速回落——
  // 每帧减固定百分点（与当前差值无关），而不是比例缓动那种越接近越慢的指数尾巴。
  // 这样点阵尾影是匀速缩短的，节奏恒定。慢条恒 >= 快条，尾影只在快条上方。
  // 渲染节流 ~120ms/帧（~8fps），SLOW_FALL_PER_FRAME=0.5 ≈ 4%/s 的回落速度，可调。
  static const float SLOW_FALL_PER_FRAME = 0.5f;
  if (g_cpuShown >= g_cpuShownSlow) g_cpuShownSlow = g_cpuShown;         // 快条更高：立刻齐平
  else { g_cpuShownSlow -= SLOW_FALL_PER_FRAME;                         // 快条更低：匀速下落
         if (g_cpuShownSlow < g_cpuShown) g_cpuShownSlow = g_cpuShown; } // 不穿过快条
  if (g_memShown >= g_memShownSlow) g_memShownSlow = g_memShown;
  else { g_memShownSlow -= SLOW_FALL_PER_FRAME;
         if (g_memShownSlow < g_memShown) g_memShownSlow = g_memShown; }
  drawBar(2, 30, LCD_W - 4, 18, (int)lroundf(g_cpuShown), (int)lroundf(g_cpuShownSlow), "CPU");
  drawBar(2, 54, LCD_W - 4, 18, (int)lroundf(g_memShown), (int)lroundf(g_memShownSlow), "MEM");
  u8g2->drawHLine(0, 78, LCD_W);

  // ── 会话列表 y=82..300（字大优先，每条 ~54px，约显 4 条）──
  int y = 82;
  const int ROW_H = 54;   // 每条：标题行(16px) + meta 行(16px) + 上下文条(8px) + 间距
  bool blinkOn = (millis() / 500) % 2 == 0; // WAITING（提问）正显↔反显闪烁节拍
  for (int i = 0; i < g_sessCount; i++) {
    if (y + ROW_H > LCD_H) break; // 放不下就停
    Session &s = g_sess[i];
    int top = y;

    // 行1：状态图标 + 标题（wqy16 中文）
    drawStateIcon(12, top + 11, s.st);
    u8g2->setFont(u8g2_font_wqy16_t_gb2312);
    u8g2->drawUTF8(26, top + 16, s.ti);

    // 行2：项目 · 来源（同样 wqy16，字大优先）。
    // age 秒数不再单列：它已被行3的存活条（消失倒计时）可视化表达，同行留数字反而冗余。
    char meta[160];
    snprintf(meta, sizeof(meta), "%s · %s", s.pj, s.pv);
    u8g2->drawUTF8(26, top + 38, meta);

    // 行3：上下文占用条（仅 Claude 会话有 cx；非 Claude/读不到时 ctx=-1，不画本条）。
    // 条画在 meta 行下方，8px 高、120px 宽，百分比数字由 drawCtxBar 贴在条右侧（数字尾约到 x≈176）。
    if (s.ctx >= 0) drawCtxBar(26, top + 42, 120, 8, s.ctx);

    // 行3 同一行右侧：剩余存活条＝消失倒计时（点阵半透明，与实心 ctx 条区分）。
    // 固定列 x=190（在 ctx 数字之后），宽 190→到 x=380（留 20px 右边距），高 8、与 ctx 条同一 y。
    // 固定列而非紧贴 ctx 尾：让每行的存活条对齐成一竖列，跨行扫读更快；非 Claude 行左侧空着可接受。
    // 不占额外垂直空间——完全落在 ctx 条那一行的空白横向区。
    if (s.life >= 0) drawLifeBar(190, top + 42, 190, 8, s.life);

    // 整条反显：判定规则「按会话状态 st」（与图标形态解耦，图标画法日后可改，此规则不受影响）——
    //   WORKING、RECENT/未知兜底 → 恒反显（活跃/近期）
    //   DONE                     → 恒正显（不反显）
    //   WAITING（提问）           → 正显↔反显闪烁（blinkOn 节拍）
    // 判定纯固件本地——st 本就在帧里，无需 PC 再下发反显标志（状态已足够，标志冗余）。
    // setDrawColor(2)=XOR 模式，drawBox 盖满整行区域把已画好的像素逐点翻转
    //（黑↔白，文字/图标/条一并反色而不擦除），完了立刻恢复 setDrawColor(1)。
    bool invert;
    if      (!strcmp(s.st, "DONE"))    invert = false;    // DONE：正显（不反显）
    else if (!strcmp(s.st, "WAITING")) invert = blinkOn;  // 提问：正反显闪烁
    else                                invert = true;     // WORKING/RECENT/未知：恒反显
    if (invert) {
      u8g2->setDrawColor(2);
      u8g2->drawBox(0, top - 2, LCD_W, ROW_H - 2);
      u8g2->setDrawColor(1);
    }

    y += ROW_H;
  }

  // 溢出提示：还有更多会话没显示
  if (g_total > g_sessCount) {
    char more[24];
    snprintf(more, sizeof(more), "+%d 更多", g_total - g_sessCount);
    u8g2->setFont(u8g2_font_wqy16_t_gb2312);
    drawRightStr(LCD_W - 2, LCD_H - 3, more);
  }

  u8g2->sendBuffer();
}

void setup() {
  // 【关键修复】ESP32-S3 原生 USB-CDC 接收 ring buffer 默认仅 256 字节。
  // 单会话帧 ~180B 没事；2+ 会话帧 300-400B 超 256 → render/sendBuffer 刷屏(几十 ms)期间不读串口，
  // 大帧灌满 256 缓冲丢字节 → JSON 被截断、解析永久失败 → cpu/mem 冻住而本地温度照常更新。
  // 调到 4KB，足够容纳最大帧 + 刷屏空窗期的积压。必须在 begin() 前调用。
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  delay(300);

  // 屏幕：横屏全缓冲
  lcd.begin(0, U8G2_R1);
  u8g2 = lcd.getU8g2();
  u8g2->enableUTF8Print();

  // 传感器
  Adc_PortInit();
  shtc3 = new Shtc3Port(i2cBus);

  sampleSensors();
  render();
  Serial.println("rlcd-screen ready");
}

void loop() {
  // 每轮都优先清空串口接收缓冲，绝不留空窗（原来的 delay(120) 会在这 120ms 内不读串口，
  // 大帧可能把 USB-CDC 接收缓冲填满、丢字节 → 整帧作废、屏幕定格。这是间歇性"冻住"的主因）。
  pumpSerial();
  sampleSensors();  // 本地温湿度/电池（内部限频 2s）

  uint32_t now = millis();

  // 待机判定：已收到过帧、非 off、且「连续 IDLE_MS 没有活跃会话」→ 待机。
  // g_lastActiveMs 在首帧被 parseFrame 置为收帧时刻，之后仅在有 WORKING/WAITING 时刷新，
  // 所以"连上就全空闲"会先显示 IDLE_MS 的仪表盘再入睡（不会一连上就待机）。
  bool standby = g_gotFrame && !g_off && g_lastActiveMs != 0 && (now - g_lastActiveMs >= IDLE_MS);

  // 活跃 ↔ 待机 跳变：强制立即重绘一次（否则待机的 20s 慢节流会让唤醒/入睡都有明显延迟）。
  bool transitioned = (standby != g_standby);
  g_standby = standby;

  // 渲染节流：活跃 ~8fps（120ms）流畅；待机 ~20s 一次（低频省刷、配合微移防残影）。
  uint32_t interval = standby ? 20000UL : 120UL;
  if (transitioned || g_lastRenderMs == 0 || (now - g_lastRenderMs) >= interval) {
    g_lastRenderMs = now;
    pumpSerial();   // 渲染前再抽一次，尽量让屏上是最新帧
    if (standby) renderStandby();
    else         render();
    pumpSerial();   // 渲染后立刻再抽一次，补上渲染 flush 期间涌入的字节
  }
  delay(2);         // 让出 CPU / 喂看门狗；2ms@115200 仅 ~23 字节，远小于接收缓冲，不会丢
}
