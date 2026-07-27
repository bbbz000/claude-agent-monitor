// electron/settings.js — 设置窗口逻辑：初始化控件、保存回传。
const COLORS = ["WORKING", "WAITING", "DONE", "RECENT", "EMPTY"];
const $ = (id) => document.getElementById(id);

function syncHex(key) {
  const inp = $(`c-${key}`);
  $(`c-${key}-hex`).textContent = inp.value.toUpperCase();
}

function init(config) {
  for (const key of COLORS) {
    $(`c-${key}`).value = config.colors[key];
    syncHex(key);
  }
  $("maxDots").value = config.maxDots;
  $("workingSec").value = config.workingSec;
  $("recentSec").value = config.recentSec;
  $("configDir").value = config.configDir || "";
  $("barBackground").value = config.barBackground;
  probe(); // 打开设置时先自动检测一次，常驻显示当前解析到的目录
}

// ── 目录检测 ─────────────────────────────────────────
const SRC_LABEL = { manual: "手动指定", env: "环境变量 CLAUDE_CONFIG_DIR", default: "默认 ~/.claude" };

// 用 textContent 构建，绝不 innerHTML 拼用户输入（r.root 含用户填的路径）→ 防注入
function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function renderProbe(r) {
  const el = $("probeResult");
  el.textContent = "";
  if (!r) return;

  // 第 1 行：状态（可能含前缀彩色 span + 后缀普通文字）
  const line1 = document.createElement("div");
  if (r.error) {
    line1.appendChild(span("bad", `✗ 检测出错：${r.error}`));
  } else if (!r.exists) {
    line1.appendChild(span("bad", "✗ 目录不存在"));
  } else if (!r.isDir) {
    line1.appendChild(span("bad", "✗ 该路径不是目录"));
  } else if (r.sessionCount === 0) {
    line1.appendChild(span("ok", "✓ 目录有效"));
    line1.appendChild(document.createTextNode("，但未发现 .jsonl 会话文件"));
  } else {
    line1.appendChild(span("ok", "✓ 目录有效"));
    line1.appendChild(document.createTextNode(`，发现 ${r.sessionCount} 个会话文件`));
  }
  el.appendChild(line1);

  // 第 2 行：来源
  const line2 = document.createElement("div");
  line2.appendChild(span("src", `来源：${SRC_LABEL[r.source] || r.source}`));
  el.appendChild(line2);

  // 第 3 行：解析出的绝对路径（用户可控，务必 textContent）
  const line3 = document.createElement("div");
  line3.appendChild(span("path", r.root));
  el.appendChild(line3);
}

async function probe() {
  const el = $("probeResult");
  el.textContent = "";
  el.appendChild(span("src", "检测中…"));
  try {
    const r = await window.settingsAPI.probe($("configDir").value.trim());
    renderProbe(r);
  } catch (e) {
    el.textContent = "";
    el.appendChild(span("bad", `✗ 检测失败：${e && e.message ? e.message : e}`));
  }
}

// 输入变化去抖后自动重测；按钮手动重测
let probeTimer = null;
$("configDir").addEventListener("input", () => {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, 400);
});
$("probe").addEventListener("click", probe);

for (const key of COLORS) {
  $(`c-${key}`).addEventListener("input", () => syncHex(key));
}

$("save").addEventListener("click", () => {
  const colors = {};
  for (const key of COLORS) colors[key] = $(`c-${key}`).value;
  window.settingsAPI.save({
    colors,
    maxDots: $("maxDots").value,
    workingSec: $("workingSec").value,
    recentSec: $("recentSec").value,
    configDir: $("configDir").value.trim(),
    barBackground: $("barBackground").value.trim(),
  });
  window.settingsAPI.close();
});

$("cancel").addEventListener("click", () => window.settingsAPI.close());

window.settingsAPI.onInit(init);
