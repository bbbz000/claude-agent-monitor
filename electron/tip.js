// electron/tip.js — 悬停气泡：收 main 推来的单个 agent 详情并渲染。
const $ = (id) => document.getElementById(id);

// 状态 → 颜色（与小条默认一致；main 会随详情一起把该状态的颜色传来）
const FALLBACK = { WORKING: "#22c55e", WAITING: "#f97316", DONE: "#06b6d4", RECENT: "#eab308", EMPTY: "#6b7280" };

// 距上次活动的“多久前”文字
function ago(sec) {
  if (sec == null) return "";
  if (sec < 60) return `${Math.round(sec)}秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)}分钟前`;
  return `${Math.round(sec / 3600)}小时前`;
}

const STATE_LABEL = {
  WORKING: "正在运行", WAITING: "等你确认/回答", DONE: "已回复", RECENT: "近期活动", EMPTY: "空闲",
};

window.tip.onData((d) => {
  const color = (d.color) || FALLBACK[d.state] || FALLBACK.RECENT;
  $("t-dot").style.setProperty("--c", color);
  $("t-title").textContent = d.title || "(无标题)";
  // meta 行：来源 · 项目（来源让多客户端同屏时一眼区分是谁的任务）
  const parts = [];
  if (d.providerLabel) parts.push(d.providerLabel);
  if (d.project) parts.push(d.project);
  $("t-meta").textContent = parts.join(" · ");
  const label = STATE_LABEL[d.state] || d.state || "";
  const act = d.activity ? ` · ${d.activity}` : "";
  $("t-act").innerHTML = `<b>${label}</b>${act}　${ago(d.ageSec)}`;
});
