// hardware/bridge/serial-bridge.js
// PC 端串口桥：定时 import scan() 拿统一状态 → 映射成 4 颗 RGB LED 的颜色 → 按 PROTOCOL.md 编码 → 写串口给 ESP32-C6。
//
// 复用现有零副作用入口 core/scanner.js 的 scan()（与 monitor.js / electron/main.js 同一份判活逻辑），
// 本文件不新增任何判活规则，只做「状态 → 颜色 → 串口帧」的搬运。
//
// 用法：
//   node hardware/bridge/serial-bridge.js --list              列出可用串口后退出
//   node hardware/bridge/serial-bridge.js --dry-run           不开串口，把帧打到 stdout（无需 serialport / 硬件）
//   node hardware/bridge/serial-bridge.js --port COM3         打开 COM3（115200）持续推送
//   node hardware/bridge/serial-bridge.js --port COM3 --baud 115200 --interval 2000
//
// serialport 依赖仅在真正开串口时才 require（--dry-run / --list 无 serialport 也能跑）。

import { scan } from "../../core/scanner.js";

// ── 参数解析 ─────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
}

const DRY_RUN = flag("--dry-run");
const LIST = flag("--list");
const PORT = opt("--port", null);
const BAUD = parseInt(opt("--baud", "115200"), 10);
const INTERVAL = parseInt(opt("--interval", "2000"), 10);
const LED_COUNT = 4; // 4 颗独立 RGB LED（物理上限）

// ── 状态 → RGB 映射（唯一真相源见 hardware/PROTOCOL.md）──
const STATE_RGB = {
  WORKING: [0, 200, 0],     // 绿
  WAITING: [255, 80, 0],    // 橙
  DONE:    [0, 120, 200],   // 青
  RECENT:  [200, 160, 0],   // 黄
};
const EMPTY = [0, 0, 0];    // 灭（空槽 / 未知状态）

// ── 把 scan() 结果编码成一帧（见 PROTOCOL.md）──
// rows 已按 ageSec 升序（最活跃在前，见 core/scanner.js）。取前 4，不足补 EMPTY。
function buildFrame(rows) {
  const slots = [];
  for (let i = 0; i < LED_COUNT; i++) {
    const st = rows[i] && rows[i].state;
    slots.push(STATE_RGB[st] || EMPTY);
  }
  return slots.map(([r, g, b]) => `${r},${g},${b}`).join(";") + "\n";
}

// 供人眼看的一行摘要（--dry-run 时附在帧后，方便对照）
function summarize(rows) {
  if (!rows.length) return "（无活跃 agent）";
  return rows.slice(0, LED_COUNT)
    .map((r, i) => `LED${i}:${r.state} ${r.title.slice(0, 20)}`)
    .join(" | ");
}

// ── serialport：仅在需要开串口时动态加载 ──
async function loadSerialPort() {
  try {
    const mod = await import("serialport");
    return mod.SerialPort;
  } catch {
    console.error(
      "未找到 serialport 依赖。请先安装：\n" +
      "  npm i serialport\n" +
      "或先用 --dry-run 无硬件测试。"
    );
    process.exit(1);
  }
}

async function listPorts() {
  const SerialPort = await loadSerialPort();
  const ports = await SerialPort.list();
  if (!ports.length) { console.log("未发现任何串口。"); return; }
  console.log("可用串口：");
  for (const p of ports) {
    const desc = [p.manufacturer, p.friendlyName || p.pnpId].filter(Boolean).join(" · ");
    console.log(`  ${p.path}${desc ? "  (" + desc + ")" : ""}`);
  }
}

// ── 主循环 ───────────────────────────────────────────
async function main() {
  if (LIST) { await listPorts(); return; }

  if (DRY_RUN) {
    console.log(`[dry-run] 每 ${INTERVAL}ms 打印一帧（不开串口）。Ctrl+C 退出。\n`);
    const tick = () => {
      let rows = [];
      try { rows = scan(); } catch (e) { console.error("扫描出错:", e.message); }
      const frame = buildFrame(rows);
      process.stdout.write(`${frame.trimEnd()}    ${summarize(rows)}\n`);
    };
    tick();
    setInterval(tick, INTERVAL);
    return;
  }

  if (!PORT) {
    console.error("请用 --port 指定串口（如 --port COM3），或 --list 查看可用串口，或 --dry-run 无硬件测试。");
    process.exit(1);
  }

  const SerialPort = await loadSerialPort();
  const sp = new SerialPort({ path: PORT, baudRate: BAUD }, (err) => {
    if (err) { console.error(`打开 ${PORT} 失败:`, err.message); process.exit(1); }
  });
  sp.on("error", (e) => console.error("串口错误:", e.message));
  sp.on("open", () => console.log(`已连接 ${PORT} @ ${BAUD}，每 ${INTERVAL}ms 推送一帧。Ctrl+C 退出。`));

  const tick = () => {
    let rows = [];
    try { rows = scan(); } catch (e) { console.error("扫描出错:", e.message); return; }
    if (sp.writable) sp.write(buildFrame(rows));
  };
  const timer = setInterval(tick, INTERVAL);

  process.on("SIGINT", () => {
    clearInterval(timer);
    // 退出前把灯全灭，避免定格
    try { if (sp.writable) sp.write(`0,0,0;0,0,0;0,0,0;0,0,0\n`); } catch {}
    setTimeout(() => { sp.close(() => process.exit(0)); }, 100);
  });
}

main();
