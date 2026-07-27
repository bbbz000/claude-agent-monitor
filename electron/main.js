// electron/main.js
// 主进程：建置顶小条窗 + 定时 scan + IPC + 多屏定位 + 右键菜单/Tray + 设置窗口。
// 默认用不透明胶囊窗（真透明窗在部分 Windows 上不合成会整窗看不见）；--transparent 可试真透明。
import { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage } from "electron";
import path from "path";
import { scan } from "../core/scanner.js";
import { load, save, resolveDisplay } from "./config.js";

const DIR = import.meta.dirname;
const DEV = process.argv.includes("--dev");
const DIAG = process.argv.includes("--diag"); // 诊断模式：亮紫底+日志，用于排查“看不见”
// 默认用真透明窗（胶囊只包住圆点、其余全透，barBackground 的 alpha 直接生效）。
// 之前“整窗看不见”是 GPU 合成把透明窗吞了 → 下面用 --disable-gpu-compositing 兜底。
// 想退回纯不透明胶囊：--opaque。
const OPAQUE = process.argv.includes("--opaque");
const TRANSPARENT = !OPAQUE && !DIAG;

// 关掉 GPU 合成：这是真透明窗在部分 Win 上整窗不显示的根因；软件合成路径下透明可靠生效。
// 仅透明模式需要；不透明/诊断模式保持默认硬件加速。
if (TRANSPARENT) {
  app.disableHardwareAcceleration();
}

// 不透明模式下的窗口底色 = 胶囊深色（与 renderer 的胶囊背景观感一致）
const OPAQUE_BG = "#1b1b24";

// 小条尺寸（DIP）。宽度按当前圆点单位数动态伸缩（右边缘固定），最少保留 1 个单位。
const BAR_HEIGHT = 34;
const DOT_SLOT = 20;   // 每个圆点占位宽（含间隔）
const BAR_PADDING = 20; // 胶囊左右内边距合计

// 给定“圆点单位数”算胶囊宽度（含左右内边距）。units 至少按 1 计（空态灰点）。
function barWidthForUnits(units) {
  const u = Math.max(1, units);
  return Math.max(60, u * DOT_SLOT + BAR_PADDING);
}

// 由 state 数组推出实际会画出的圆点单位数，与 renderer.render() 的逻辑保持一致：
//   空态 → 1（一个灰点）；否则 = min(len, maxDots) + (是否溢出的 …+N 占 1 个单位)
function dotUnits(states) {
  const n = states ? states.length : 0;
  if (n === 0) return 1;
  const shown = Math.min(n, config.maxDots);
  const overflow = n - shown > 0 ? 1 : 0;
  return shown + overflow;
}

// 当前应有的窗口宽度（按最近一次 state）
let lastUnits = 1;
function currentBarWidth() {
  return barWidthForUnits(lastUnits);
}

let config;
let barWin = null;
let settingsWin = null;
let tray = null;
let scanTimer = null;
let topTimer = null;           // 置顶守护定时器
let programmaticMove = false; // true 时的 moved 事件由程序触发，非用户拖动，需忽略

// ── 定位：把小条贴到目标显示器的任务栏带 ───────────────
// 内部用 setBar() 统一 setBounds，并打上 programmaticMove 标记，
// 避免程序定位触发的 moved 事件被误判成用户拖动。
function setBar(bounds) {
  programmaticMove = true;
  barWin.setBounds(bounds);
  // moved 事件在 Windows 上可能略晚于 setBounds 返回，留一个窗口再解除标记
  setTimeout(() => { programmaticMove = false; }, 250);
}

function positionBar() {
  if (!barWin) return;

  const w = currentBarWidth();
  const h = BAR_HEIGHT;

  // 自由模式：用户拖动过 → 直接用记住的绝对坐标，不再自动贴任务栏
  if (config.position === "free" && config.freePos) {
    // freePos 存的是“右边缘”锚点：宽度变化时右边缘不动、向左伸缩。
    // 兼容旧配置（存的是左上角 x）：用 x + 当前宽度推出右边缘。
    const fp = config.freePos;
    const right = fp.right != null ? fp.right : (fp.x + w);
    const x = right - w;
    const y = fp.y;
    // 校验坐标仍落在某个显示器内（防止拔屏后小条消失在屏外）。
    // 用整屏 bounds（含任务栏带）而非 workArea：小条本就允许贴在任务栏上，
    // 若拖到任务栏带内、y 会超出 workArea 底边，用 workArea 校验会误判“出屏”。
    const onScreen = screen.getAllDisplays().some((d) => {
      const bb = d.bounds;
      return x + w > bb.x && x < bb.x + bb.width && y + h > bb.y && y < bb.y + bb.height;
    });
    if (onScreen) {
      setBar({ x: Math.round(x), y: Math.round(y), width: w, height: h });
      return;
    }
    if (DIAG) console.log("[bar] free OFFSCREEN → fallback. right:", right, "w:", w, "x:", x, "y:", y);
    // 坐标失效 → 落回主屏任务栏右下（不覆盖存储，插回屏幕即可恢复）
  }

  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const disp = resolveDisplay(config, displays, primary);
  const b = disp.bounds;      // 整屏（含任务栏），DIP
  const wa = disp.workArea;   // 可用区（不含任务栏），DIP

  const { x: ox, y: oy } = config.offset || { x: 0, y: 0 };

  // 任务栏带底部 y：贴在屏幕最底（压在任务栏上方），或 workArea 内（不压任务栏）
  const taskbarTop = wa.y + wa.height;        // 任务栏顶边
  const screenBottom = b.y + b.height;

  let x, y;
  switch (config.position) {
    case "bottom-left":
      x = b.x;
      y = screenBottom - h;
      break;
    case "bottom-center":
      x = b.x + Math.round((b.width - w) / 2);
      y = screenBottom - h;
      break;
    case "workarea-bottom-right":
      // 不压任务栏：贴在可用区右下（任务栏上方）
      x = wa.x + wa.width - w;
      y = taskbarTop - h;
      break;
    case "bottom-right":
    default:
      x = b.x + b.width - w;
      y = screenBottom - h;
      break;
  }

  x += ox;
  y += oy;
  const bounds = { x: Math.round(x), y: Math.round(y), width: w, height: h };
  setBar(bounds);
  if (DIAG) console.log("[bar] position:", config.position, "bounds:", JSON.stringify(bounds),
    "disp.bounds:", JSON.stringify(b), "workArea:", JSON.stringify(wa));
}

// ── 建小条窗 ─────────────────────────────────────────
function createBar() {
  barWin = new BrowserWindow({
    width: currentBarWidth(), // 初始按 1 单位；ready-to-show 首扫后按实际圆点数重定位
    height: BAR_HEIGHT,
    transparent: TRANSPARENT, // 默认真透明（已关 GPU 合成兜底，避免整窗不显示）
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,      // 允许拖动（配合 renderer 的 -webkit-app-region: drag）
    focusable: true,    // 可拖动窗口需可获焦
    hasShadow: false,
    show: false,
    // 诊断=亮紫；透明模式=全透明底(桌面透出)；不透明=胶囊深色底
    backgroundColor: DIAG ? "#ff00ff" : (TRANSPARENT ? "#00000000" : OPAQUE_BG),
    webPreferences: {
      preload: path.join(DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  barWin.setAlwaysOnTop(true, "screen-saver");
  barWin.loadFile(path.join(DIR, "renderer.html"));

  barWin.once("ready-to-show", () => {
    positionBar();
    barWin.showInactive(); // 不抢焦点
    barWin.moveTop();      // 强制提到最上层
    pushConfig();
    tick(); // 立即扫一次
    if (DIAG) console.log("[bar] shown. isVisible:", barWin.isVisible(), "bounds:", JSON.stringify(barWin.getBounds()));
  });

  // 用户拖动小条 → 记住绝对坐标并切到自由模式（之后不再自动贴任务栏）
  let moveSaveTimer = null;
  barWin.on("moved", () => {
    if (!barWin || barWin.isDestroyed()) return;
    if (programmaticMove) return; // 程序定位触发的，不算用户拖动
    const b = barWin.getBounds();
    // 存“右边缘”而非左上角 x：这样圆点增减时宽度变化，右边缘保持不动、向左伸缩
    const right = b.x + b.width;
    const y = b.y;
    // 去抖：拖动过程会频繁触发，停下 300ms 再存盘
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      config = { ...config, position: "free", freePos: { right, y } };
      save(app.getPath("userData"), config);
      rebuildMenus(); // 让菜单里的“位置”单选反映当前为自由模式
      if (DIAG) console.log("[bar] moved → free right:", right, "y:", y);
    }, 300);
  });

  if (DEV) barWin.webContents.openDevTools({ mode: "detach" });
}

// ── 置顶守护 ─────────────────────────────────────────
// Win11 任务栏会周期性抢到最顶层，把贴在其上方的小条盖住。
// alwaysOnTop 一次性设置不足以对抗，故每轮扫描重新提顶（开销极小）。
function keepOnTop() {
  if (!barWin || barWin.isDestroyed()) return;
  if (!barWin.isVisible()) return;
  try {
    barWin.setAlwaysOnTop(true, "screen-saver");
    barWin.moveTop();
  } catch {}
}

// ── 扫描 → 只推 state 数组（隐私/性能：不传标题/路径）────
function tick() {
  if (!barWin || barWin.isDestroyed()) return;
  try {
    const rows = scan({ workingSec: config.workingSec, recentSec: config.recentSec });
    const states = rows.map((r) => r.state);
    if (DIAG) console.log("[bar] tick states=", JSON.stringify(states), "(", states.length, "agents )");
    barWin.webContents.send("agents:update", states);
    // 圆点单位数变化 → 重算窗口宽度并重定位（右边缘固定）
    const units = dotUnits(states);
    if (units !== lastUnits) {
      lastUnits = units;
      positionBar();
    }
  } catch (e) {
    if (DIAG) console.log("[bar] scan error:", e.message);
  }
}

function startScanLoop() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(tick, config.refreshMs);
  // 置顶守护单独跑更快的定时器（纯内存操作，与磁盘扫描解耦），
  // 让被任务栏盖住后能在 ~600ms 内恢复，而不必把扫描频率也提高。
  if (topTimer) clearInterval(topTimer);
  topTimer = setInterval(keepOnTop, 600);
}

function pushConfig() {
  if (barWin && !barWin.isDestroyed()) {
    // opaque：纯不透明窗（四角需铺满、不留圆角露底）；透明窗则 false
    barWin.webContents.send("config:update", { ...config, opaque: !TRANSPARENT });
  }
}

// 配置变更后统一处理：存盘 + 重定位 + 重启循环（若 refresh 变） + 下发
function applyConfig(next, { reposition = true, restartLoop = false } = {}) {
  config = next;
  save(app.getPath("userData"), config);
  if (reposition) positionBar();
  if (restartLoop) startScanLoop();
  pushConfig();
  rebuildMenus();
}

// ── 右键菜单 / Tray ──────────────────────────────────
function buildMenuTemplate() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  const displayItems = [
    {
      label: "主显示器",
      type: "radio",
      checked: config.displayId == null,
      click: () => applyConfig({ ...config, displayId: null }),
    },
    ...displays.map((d, i) => {
      const isPrimary = d.id === primary.id;
      return {
        label: `显示器 ${i + 1}${isPrimary ? "（主）" : ""}  ${d.bounds.width}×${d.bounds.height}`,
        type: "radio",
        checked: config.displayId === d.id,
        click: () => applyConfig({ ...config, displayId: d.id }),
      };
    }),
  ];

  const positionItems = [
    { label: "自由拖动（当前位置）", type: "radio", checked: config.position === "free",
      // 选它=保持当前所在位置进入自由模式；若还没坐标则记录当前窗口右边缘
      click: () => {
        const b = barWin ? barWin.getBounds() : { x: 0, width: 0, y: 0 };
        const here = { right: b.x + b.width, y: b.y };
        applyConfig({ ...config, position: "free", freePos: config.freePos || here });
      } },
    { type: "separator" },
    ...[
      ["workarea-bottom-right", "贴任务栏·右下（不压任务栏）"],
      ["bottom-right", "贴任务栏·右下"],
      ["bottom-center", "贴任务栏·底部居中"],
      ["bottom-left", "贴任务栏·左下"],
    ].map(([val, label]) => ({
      label,
      type: "radio",
      checked: config.position === val,
      click: () => applyConfig({ ...config, position: val }),
    })),
  ];

  const thresholdItems = [
    [60, "1 分钟"],
    [120, "2 分钟"],
    [300, "5 分钟"],
    [600, "10 分钟"],
  ].map(([sec, label]) => ({
    label,
    type: "radio",
    checked: config.recentSec === sec,
    click: () => applyConfig({ ...config, recentSec: sec }, { restartLoop: false }),
  }));

  const offsetItems = [
    { label: "向左 ←", click: () => nudge(-10, 0) },
    { label: "向右 →", click: () => nudge(10, 0) },
    { label: "向上 ↑", click: () => nudge(0, -10) },
    { label: "向下 ↓", click: () => nudge(0, 10) },
    { type: "separator" },
    { label: "重置微调", click: () => applyConfig({ ...config, offset: { x: config.position === "bottom-right" ? -12 : 0, y: 0 } }) },
  ];

  return [
    { label: "Claude Agent Monitor", enabled: false },
    { type: "separator" },
    { label: "选择显示器", submenu: displayItems },
    { label: "位置", submenu: positionItems },
    { label: "位置微调", submenu: offsetItems },
    { label: "活跃阈值", submenu: thresholdItems },
    { type: "separator" },
    { label: "设置…", click: openSettings },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ];
}

function nudge(dx, dy) {
  const offset = { x: (config.offset?.x || 0) + dx, y: (config.offset?.y || 0) + dy };
  applyConfig({ ...config, offset });
}

function rebuildMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function createTray() {
  // 用 1x1 透明位图占位（无图标文件也能建 Tray；Windows 会显示默认区域）
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSFsFAO2m/wF3AAAAAElFTkSuQmCC"
  );
  tray = new Tray(img);
  tray.setToolTip("Claude Agent Monitor");
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  // 单击托盘也弹菜单（小条被遮时的兜底）
  tray.on("click", () => tray.popUpContextMenu());
}

// ── 设置窗口 ─────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    title: "设置 · Claude Agent Monitor",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(DIR, "settings.html"));
  settingsWin.once("ready-to-show", () => {
    settingsWin.webContents.send("settings:init", config);
  });
  settingsWin.on("closed", () => { settingsWin = null; });
}

// ── IPC ──────────────────────────────────────────────
ipcMain.on("settings:save", (_e, incoming) => {
  // 白名单合并：只接受已知字段，防止渲染层塞脏数据
  const next = {
    ...config,
    colors: { ...config.colors, ...(incoming.colors || {}) },
    maxDots: clampInt(incoming.maxDots, 1, 50, config.maxDots),
    workingSec: clampInt(incoming.workingSec, 1, 3600, config.workingSec),
    recentSec: clampInt(incoming.recentSec, 5, 86400, config.recentSec),
    barBackground: typeof incoming.barBackground === "string" ? incoming.barBackground : config.barBackground,
  };
  // maxDots 变化需要改窗宽 → 重定位；refreshMs 未在设置窗口暴露，故不重启循环
  applyConfig(next);
});

ipcMain.on("settings:close", () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── 显示器插拔 → 重定位 ──────────────────────────────
function wireScreenEvents() {
  const relayout = () => { positionBar(); rebuildMenus(); };
  screen.on("display-added", relayout);
  screen.on("display-removed", relayout);
  screen.on("display-metrics-changed", relayout);
}

// ── 启动 ─────────────────────────────────────────────
app.whenReady().then(() => {
  config = load(app.getPath("userData"));
  createBar();
  createTray();
  wireScreenEvents();
  startScanLoop();
});

// 小条是常驻工具：关掉所有窗口不退出（靠 Tray/右键退出）
app.on("window-all-closed", (e) => {
  // 阻止默认退出；用户通过菜单“退出”才真正结束
});

app.on("before-quit", () => {
  if (scanTimer) clearInterval(scanTimer);
  if (topTimer) clearInterval(topTimer);
});
