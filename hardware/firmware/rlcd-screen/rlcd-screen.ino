// rlcd-screen.ino
// ESP32-S3-RLCD-4.2（微雪 4.2" 300x400 反射式单色 LCD，ST7305）Agent Monitor 信息面板固件。
//
// 从 PC 端 claude-agent-monitor 经串口收「每帧一行 JSON」，渲染成三区面板：
//   顶栏     ：时钟(PC 下发) · 温湿度(本地 SHTC3) · 电池%(本地 ADC)
//   指标带   ：CPU% / 内存%（PC 下发，带百分比条）
//   会话列表 ：状态图标 + 标题 + 项目·来源·age；WAITING 会话边框闪烁提醒
//
// 协议真相源见 ../../SCREEN_PROTOCOL.md。
//
// 依赖库（Arduino IDE 库管理器安装）：
//   - U8g2（单色图形，含 wqy12 中文字体）
//   - ArduinoJson（v6/v7 皆可）
// SHTC3/ADC 用板载 ESP-IDF 驱动（Arduino-ESP32 core 自带），已随本目录附带 BSP 文件。
//
// 板卡设置见微雪 Tools-Configuration：Board=ESP32S3 Dev Module, PSRAM=OPI PSRAM,
// Flash=16MB, USB CDC On Boot=Enabled（这样 Serial 走原生 USB）。

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
  bool waiting;  // 是否等待确认（边框闪烁）
};
static const int MAX_SESS = 8;

static char   g_clock[8] = "";     // PC 下发时钟 HH:MM
static int    g_cpu = 0;
static int    g_mem = 0;
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
static uint32_t g_rxLines = 0;       // 【诊断】收到的行数（每个非空 \n 计一次）
static uint32_t g_rxFrames = 0;      // 【诊断】成功解析的帧数（JSON 解析通过，含 off 帧）

// 是否至少收到过一帧（没收到就显示等待提示）
static bool   g_gotFrame = false;

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
  g_rxFrames++;    // 【诊断】解析成功

  if (doc["off"].as<bool>()) { g_off = true; g_gotFrame = true; return; }
  g_off = false;
  g_gotFrame = true;

  copyStr(g_clock, sizeof(g_clock), doc["t"] | "");
  g_cpu = doc["cpu"] | 0;
  g_mem = doc["mem"] | 0;
  g_total = doc["total"] | 0;

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
    g_sessCount++;
  }
}

// ── 串口收数：逐字节拼行，遇 \n 解析一帧 ──────────────────
static void pumpSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      lineBuf[lineLen] = 0;
      if (lineLen > 0) { g_rxLines++; parseFrame(lineBuf, lineLen); } // 【诊断】收到一整行
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

// 画一个 0..100 的百分比条（label 在左，条在右）
static void drawBar(int x, int y, int w, int h, int pct, const char *label) {
  u8g2->setFont(u8g2_font_6x12_tf);
  u8g2->drawStr(x, y + h - 2, label);
  int labelW = 40;                       // 给 "CPU"/"MEM" + 空格留固定宽
  int bx = x + labelW;
  int bw = w - labelW - 34;              // 右侧留 34px 显 "100%"
  if (bw < 10) bw = 10;
  u8g2->drawFrame(bx, y, bw, h);
  int fill = (bw - 2) * (pct < 0 ? 0 : pct > 100 ? 100 : pct) / 100;
  if (fill > 0) u8g2->drawBox(bx + 1, y + 1, fill, h - 2);
  char pctStr[8];
  snprintf(pctStr, sizeof(pctStr), "%d%%", pct);
  u8g2->drawStr(bx + bw + 4, y + h - 2, pctStr);
}

// 状态图标：用简单几何形区分（单色屏无颜色）
//   WORKING ●(实心) / WAITING ▶(三角，闪) / DONE ○(空心) / RECENT ·(小点)
static void drawStateIcon(int cx, int cy, const char *st) {
  if (!strcmp(st, "WORKING"))      u8g2->drawDisc(cx, cy, 4);
  else if (!strcmp(st, "WAITING")) u8g2->drawTriangle(cx - 4, cy - 4, cx - 4, cy + 4, cx + 4, cy);
  else if (!strcmp(st, "DONE"))    u8g2->drawCircle(cx, cy, 4);
  else                              u8g2->drawDisc(cx, cy, 2); // RECENT / 其它
}

// ── 渲染整屏 ────────────────────────────────────────────
static void render() {
  u8g2->clearBuffer();
  u8g2->setDrawColor(1);

  // 未收到任何帧：提示等待
  if (!g_gotFrame || g_off) {
    u8g2->setFont(u8g2_font_wqy12_t_gb2312);
    const char *msg = g_off ? "已断开" : "等待 PC 连接…";
    int w = u8g2->getUTF8Width(msg);
    u8g2->drawUTF8((LCD_W - w) / 2, LCD_H / 2, msg);
    // 即便没帧也显示本地温湿度/电池，证明板子活着
    char line[48];
    snprintf(line, sizeof(line), "%.1fC  %.0f%%RH  BAT %d%%", g_temp, g_humi, g_batt);
    u8g2->setFont(u8g2_font_6x12_tf);
    int lw = u8g2->getStrWidth(line);
    u8g2->drawStr((LCD_W - lw) / 2, LCD_H / 2 + 20, line);
    u8g2->sendBuffer();
    return;
  }

  // ── 顶栏 y=0..16 ──
  // 左：时钟
  u8g2->setFont(u8g2_font_7x14B_tf);
  u8g2->drawStr(2, 14, g_clock[0] ? g_clock : "--:--");
  // 中：温湿度
  char th[32];
  if (g_thValid) snprintf(th, sizeof(th), "%.1fC %.0f%%", g_temp, g_humi);
  else           snprintf(th, sizeof(th), "--C --%%");
  u8g2->setFont(u8g2_font_6x12_tf);
  int thw = u8g2->getStrWidth(th);
  u8g2->drawStr((LCD_W - thw) / 2, 13, th);
  // 右：电池
  char bat[16];
  snprintf(bat, sizeof(bat), "BAT %d%%", g_batt);
  drawRightStr(LCD_W - 2, 13, bat);
  u8g2->drawHLine(0, 17, LCD_W);

  // ── 指标带 y=20..60（约屏高 1/5）──
  drawBar(2, 22, LCD_W - 4, 14, g_cpu, "CPU");
  drawBar(2, 40, LCD_W - 4, 14, g_mem, "MEM");
  u8g2->drawHLine(0, 58, LCD_W);

  // ── 会话列表 y=62..300 ──
  int y = 62;
  const int ROW_H = 30;   // 每条约 2 行 + 间距
  bool blinkOn = (millis() / 500) % 2 == 0; // WAITING 边框闪烁节拍
  for (int i = 0; i < g_sessCount; i++) {
    if (y + ROW_H > LCD_H) break; // 放不下就停
    Session &s = g_sess[i];
    int top = y;

    // WAITING 边框闪烁：亮的半拍画框
    if (s.waiting && blinkOn) {
      u8g2->drawFrame(0, top - 1, LCD_W, ROW_H - 2);
    }

    // 行1：状态图标 + 标题
    drawStateIcon(10, top + 8, s.st);
    u8g2->setFont(u8g2_font_wqy12_t_gb2312);
    u8g2->drawUTF8(20, top + 12, s.ti);

    // 行2：项目 · 来源 · age（灰信息，用小字体）
    char meta[160];
    snprintf(meta, sizeof(meta), "%s · %s · %ds", s.pj, s.pv, s.age);
    u8g2->drawUTF8(20, top + 26, meta);

    y += ROW_H;
  }

  // 溢出提示：还有更多会话没显示
  if (g_total > g_sessCount) {
    char more[24];
    snprintf(more, sizeof(more), "+%d 更多", g_total - g_sessCount);
    u8g2->setFont(u8g2_font_wqy12_t_gb2312);
    drawRightStr(LCD_W - 2, LCD_H - 2, more);
  }

  // 【诊断】左下角显示 收到行数/解析帧数（L=行 F=帧）。冻住时看这俩涨不涨：
  //   都不涨 → PC 停发帧（scan 卡死）；L 涨 F 不涨 → 帧到了但解析失败。稳定后可删。
  char dbg[32];
  snprintf(dbg, sizeof(dbg), "L%lu F%lu", (unsigned long)g_rxLines, (unsigned long)g_rxFrames);
  u8g2->setFont(u8g2_font_5x7_tf);
  u8g2->drawStr(2, LCD_H - 2, dbg);

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

  // 渲染用 millis 节流（~8fps），不用 delay 阻塞：render 期间不读串口，节流本身只决定"多久重绘一次"。
  uint32_t now = millis();
  if (g_lastRenderMs == 0 || (now - g_lastRenderMs) >= 120) {
    g_lastRenderMs = now;
    pumpSerial();   // 渲染前再抽一次，尽量让屏上是最新帧
    render();
    pumpSerial();   // 渲染后立刻再抽一次，补上渲染 flush 期间涌入的字节
  }
  delay(2);         // 让出 CPU / 喂看门狗；2ms@115200 仅 ~23 字节，远小于接收缓冲，不会丢
}
