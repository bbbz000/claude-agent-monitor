// electron/main.js
// 主进程：建置顶小条窗 + 定时 scan + IPC + 多屏定位 + 右键菜单/Tray + 设置窗口。
// 默认用不透明胶囊窗（真透明窗在部分 Windows 上不合成会整窗看不见）；--transparent 可试真透明。
import { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage } from "electron";
import path from "path";
import { scan } from "../core/scanner.js";
import { allProviders, listMeta } from "../core/providers/registry.js";
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
const BAR_PADDING = 6; // 胶囊左右内边距合计

// 给定“圆点单位数”算胶囊宽度（含左右内边距）。units 至少按 1 计（空态灰点）。
function barWidthForUnits(units) {
  const u = Math.max(1, units);
  return Math.max(44, u * DOT_SLOT + BAR_PADDING);
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
let tipWin = null;             // 悬停气泡窗（透明置顶，只在 hover 时显示）
let tray = null;
let scanTimer = null;
let topTimer = null;           // 置顶守护定时器
let lastRows = [];             // 最近一次 scan 的完整结果（供 hover 查详情；小条本身仍只收 state）
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

  // 有自由锚点就用它（拖动过或勾选过）：draggable 只控制“能不能拖”，
  // 不控制“停在哪”——取消勾选后仍留在原地，不弹回任务栏。
  if (config.freePos) {
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

  // 用户拖动小条（仅在“自由拖动”开启时）→ 记住右边缘锚点，用于宽度伸缩定位
  let moveSaveTimer = null;
  barWin.on("moved", () => {
    if (!barWin || barWin.isDestroyed()) return;
    if (programmaticMove) return;   // 程序定位触发的，不算用户拖动
    if (!config.draggable) return;  // 未开自由拖动 → 忽略（不再被动切 free、不再重复勾选）
    const b = barWin.getBounds();
    // 存“右边缘”而非左上角 x：这样圆点增减时宽度变化，右边缘保持不动、向左伸缩
    const right = b.x + b.width;
    const y = b.y;
    // 去抖：拖动过程会频繁触发，停下 300ms 再存盘
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      config = { ...config, freePos: { right, y } };
      save(app.getPath("userData"), config);
      if (DIAG) console.log("[bar] moved → freePos right:", right, "y:", y);
    }, 300);
  });

  if (DEV) barWin.webContents.openDevTools({ mode: "detach" });
}

// ── 悬停气泡窗 ───────────────────────────────────────
// 小条只有 34px 高，气泡画在窗内会被裁掉，故用独立透明置顶小窗承载。
// 鼠标穿透（setIgnoreMouseEvents），只做展示，不抢 hover。
const TIP_W = 340, TIP_H = 96; // 窗口画布（气泡实际尺寸更小，多余部分透明）
function createTip() {
  tipWin = new BrowserWindow({
    width: TIP_W, height: TIP_H,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false, hasShadow: false, show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(DIR, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  tipWin.setAlwaysOnTop(true, "screen-saver");
  tipWin.setIgnoreMouseEvents(true); // 鼠标穿透：气泡不挡小条
  tipWin.loadFile(path.join(DIR, "tip.html"));
}

// 显示气泡：按小条内圆点中心 X（DIP）把气泡定位到该圆点正上方
function showTip(index, dotCenterX) {
  if (!tipWin || tipWin.isDestroyed() || !barWin || barWin.isDestroyed()) return;
  const row = lastRows[index];
  if (!row) return;
  // 只推单条详情（含该状态颜色），renderer 侧无标题/路径，隐私最小暴露
  const color = (config.colors && config.colors[row.state]) || null;
  tipWin.webContents.send("tip:data", {
    title: row.title, project: row.project, activity: row.activity,
    ageSec: row.ageSec, state: row.state, color,
    providerLabel: row.providerLabel, // 来源可读名，气泡里显示「Claude Code · 项目」
  });
  // 定位：气泡水平中心对齐圆点，竖直放在小条上方
  const bb = barWin.getBounds();
  const cx = bb.x + (dotCenterX || bb.width / 2);
  let x = Math.round(cx - TIP_W / 2);
  let y = Math.round(bb.y - TIP_H + 6); // 略微与小条重叠，视觉更连贯
  // 夹在圆点所在显示器内，避免气泡跑出屏幕左右/顶边被裁
  const disp = screen.getDisplayNearestPoint({ x: Math.round(cx), y: bb.y });
  const wa = disp.workArea;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - TIP_W));
  if (y < wa.y) y = bb.y + bb.height - 6; // 顶边不够 → 放到小条下方
  tipWin.setBounds({ x, y, width: TIP_W, height: TIP_H });
  tipWin.showInactive();
  tipWin.moveTop();
}

function hideTip() {
  if (tipWin && !tipWin.isDestroyed() && tipWin.isVisible()) tipWin.hide();
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
    const rows = scan({
      workingSec: config.workingSec,
      recentSec: config.recentSec,
      providers: config.providers,
      providerConfigs: config.providerConfigs,
    });
    lastRows = rows; // 存完整结果供 hover 查详情（隐私：只在悬停时才把单条推给气泡窗）
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
    // draggable：renderer 据此动态开关 -webkit-app-region，未开时整条不可拖
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

  return [
    { label: "Agent Monitor", enabled: false },
    { type: "separator" },
    {
      label: "自由拖动",
      type: "checkbox",
      checked: !!config.draggable,
      // 勾选=开启自由拖动：以当前窗口位置作锚点，原地不动，此后可拖。
      // 取消=只锁定（不可再拖），小条留在当前位置不动（保留 freePos）。
      click: (item) => {
        const b = barWin ? barWin.getBounds() : { x: 0, width: 0, y: 0 };
        const here = { right: b.x + b.width, y: b.y };
        // 无论开关方向，都把 freePos 钉在当前位置：勾选后可拖、取消后原地锁定
        applyConfig({ ...config, draggable: item.checked, freePos: config.freePos || here });
      },
    },
    { label: "活跃阈值", submenu: thresholdItems },
    { type: "separator" },
    { label: "设置…", click: openSettings },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ];
}

function rebuildMenus() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

function createTray() {
  // 优先用打包的图标文件（32×32 绿点，呼应小条主题）；读失败则回退透明占位图
  let img = nativeImage.createFromPath(path.join(DIR, "tray-icon.png"));
  if (img.isEmpty()) {
    img = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPhfz0AEYBxVSFsFAO2m/wF3AAAAAElFTkSuQmCC"
    );
  }
  tray = new Tray(img);
  tray.setToolTip("Agent Monitor");
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
    height: 700,
    resizable: false,
    title: "设置 · Agent Monitor",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(DIR, "settings.html"));
  settingsWin.once("ready-to-show", () => {
    // 连同全部 provider 元信息一起下发，供设置界面动态列出「数据源」开关
    settingsWin.webContents.send("settings:init", config, listMeta());
  });
  settingsWin.on("closed", () => { settingsWin = null; });
}

// ── IPC ──────────────────────────────────────────────
// 悬停/移出圆点 → 显示/隐藏气泡
ipcMain.on("tip:hover", (_e, payload) => {
  if (!payload) return;
  showTip(payload.index, payload.dotCenterX);
});
ipcMain.on("tip:unhover", () => hideTip());

ipcMain.on("settings:save", (_e, incoming) => {
  // 白名单合并：只接受已知字段，防止渲染层塞脏数据
  // providers：只保留真实存在的 provider id（防伪造）；空数组=用户显式全关，保留其语义
  const provs = allProviders();
  const knownIds = new Set(provs.map((p) => p.id));
  let providers = config.providers;
  if (Array.isArray(incoming.providers)) {
    providers = incoming.providers.filter((id) => knownIds.has(id));
  }
  // providerConfigs：逐 provider 按其 configSchema 声明的 key 收字符串值（只认 schema 里的键，防脏数据）
  const providerConfigs = { ...config.providerConfigs };
  const incPC = (incoming.providerConfigs && typeof incoming.providerConfigs === "object") ? incoming.providerConfigs : {};
  for (const p of provs) {
    const inc = incPC[p.id];
    if (!inc || typeof inc !== "object") continue;
    const cur = { ...(providerConfigs[p.id] || {}) };
    for (const field of p.configSchema || []) {
      if (Object.prototype.hasOwnProperty.call(inc, field.key)) {
        const v = inc[field.key];
        cur[field.key] = typeof v === "string" ? v.trim() : String(v == null ? "" : v);
      }
    }
    providerConfigs[p.id] = cur;
  }
  const next = {
    ...config,
    colors: { ...config.colors, ...(incoming.colors || {}) },
    maxDots: clampInt(incoming.maxDots, 1, 50, config.maxDots),
    workingSec: clampInt(incoming.workingSec, 1, 3600, config.workingSec),
    recentSec: clampInt(incoming.recentSec, 5, 86400, config.recentSec),
    barBackground: typeof incoming.barBackground === "string" ? incoming.barBackground : config.barBackground,
    providers,
    providerConfigs,
  };
  // maxDots 变化需要改窗宽 → 重定位；providers/路径 变化下一轮 tick 自动生效
  applyConfig(next);
  tick(); // 立即扫一次，让改数据源/阈值即时生效，不必等下一个 refreshMs
});

ipcMain.on("settings:close", () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// 检测某 provider 的数据目录：按 id 找 provider，调其 probe（只读探测，回传给设置窗）
ipcMain.handle("settings:probe", (_e, providerId, providerCfg) => {
  const p = allProviders().find((x) => x.id === providerId);
  if (!p || typeof p.probe !== "function") return null;
  return p.probe(providerCfg && typeof providerCfg === "object" ? providerCfg : {});
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
  createTip();
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
