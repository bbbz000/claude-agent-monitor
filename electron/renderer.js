// electron/renderer.js — 纯 UI：收 IPC 画圆点、折叠、应用颜色。
const barEl = document.getElementById("bar");
const dotsEl = document.getElementById("dots");

let cfg = {
  colors: { WORKING: "#22c55e", WAITING: "#f97316", DONE: "#06b6d4", RECENT: "#eab308", EMPTY: "#6b7280" },
  maxDots: 12,
  barBackground: "rgba(0,0,0,0.35)",
};
let lastStates = [];

function applyConfig(next) {
  cfg = { ...cfg, ...next, colors: { ...cfg.colors, ...(next.colors || {}) } };
  // 不透明窗：让胶囊铺满整窗、四角不留圆角（否则露出窗口底色方块）
  document.body.classList.toggle("opaque", !!next.opaque);
  // 自由拖动：只有开启时整条才可拖（-webkit-app-region: drag 由 CSS 按此类切换）
  document.body.classList.toggle("draggable", !!next.draggable);
  barEl.style.setProperty("--bar-bg", cfg.barBackground || "transparent");
  render(lastStates);
}

function render(states) {
  lastStates = states || [];
  dotsEl.innerHTML = "";

  // 空态：一个灰色占位点
  if (lastStates.length === 0) {
    const d = document.createElement("div");
    d.className = "dot empty";
    d.style.setProperty("--c", cfg.colors.EMPTY);
    dotsEl.appendChild(d);
    return;
  }

  const max = cfg.maxDots;
  const shown = lastStates.slice(0, max);
  const overflow = lastStates.length - shown.length;

  for (const state of shown) {
    const d = document.createElement("div");
    // WORKING 呼吸；WAITING 更急促闪烁（提示“需要你”）
    const anim = state === "WORKING" ? " working" : (state === "WAITING" ? " waiting" : "");
    d.className = "dot" + anim;
    const color = cfg.colors[state] || cfg.colors.RECENT;
    d.style.setProperty("--c", color);
    dotsEl.appendChild(d);
  }

  if (overflow > 0) {
    const m = document.createElement("div");
    m.className = "more";
    m.textContent = `…+${overflow}`;
    dotsEl.appendChild(m);
  }
}

// 屏蔽右键：无边框可拖窗上右键会弹出 Windows 系统窗口菜单（还原/移动/关闭），
// 不是我们想要的。菜单统一走托盘图标。
window.addEventListener("contextmenu", (e) => e.preventDefault());

window.bar.onConfig(applyConfig);
window.bar.onAgents(render);
