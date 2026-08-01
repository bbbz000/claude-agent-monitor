// electron/settings.js — 设置窗口逻辑：初始化控件、动态列出 provider 数据源、保存回传。
const COLORS = ["WORKING", "WAITING", "DONE", "RECENT", "EMPTY"];
const $ = (id) => document.getElementById(id);

function syncHex(key) {
  const inp = $(`c-${key}`);
  $(`c-${key}-hex`).textContent = inp.value.toUpperCase();
}

// 用 textContent 构建，绝不 innerHTML 拼用户输入 → 防注入
function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

const SRC_LABEL = { manual: "手动指定", env: "环境变量", default: "默认路径" };

function renderProbe(el, r) {
  el.textContent = "";
  if (!r) { el.appendChild(span("bad", "✗ 该数据源不支持检测")); return; }

  const line1 = document.createElement("div");
  if (r.error) line1.appendChild(span("bad", `✗ 检测出错：${r.error}`));
  else if (!r.exists) line1.appendChild(span("bad", "✗ 目录不存在"));
  else if (!r.isDir) line1.appendChild(span("bad", "✗ 该路径不是目录"));
  else if (r.sessionCount === 0) {
    line1.appendChild(span("ok", "✓ 目录有效"));
    line1.appendChild(document.createTextNode("，但未发现会话文件"));
  } else {
    line1.appendChild(span("ok", "✓ 目录有效"));
    line1.appendChild(document.createTextNode(`，发现 ${r.sessionCount} 个会话文件`));
  }
  el.appendChild(line1);

  const line2 = document.createElement("div");
  line2.appendChild(span("src", `来源：${SRC_LABEL[r.source] || r.source}`));
  el.appendChild(line2);

  const line3 = document.createElement("div");
  line3.appendChild(span("path", r.root));
  el.appendChild(line3);
}

// ── 数据源（provider）动态渲染 ───────────────────────
// providers 语义：null/未设 = 全部启用；[] = 全关；否则按数组。
let PROVIDERS = []; // [{id,label}]
const probeTimers = {};

function isEnabled(config, id) {
  if (config.providers == null) return true; // null = 全启用
  return config.providers.includes(id);
}

function buildProviderRow(meta, config) {
  const { id, label } = meta;
  const cfg = (config.providerConfigs && config.providerConfigs[id]) || {};

  const box = document.createElement("div");
  box.className = "prov";
  box.dataset.id = id;

  // 头部：开关 + 名称
  const head = document.createElement("div");
  head.className = "prov-head";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.id = `prov-on-${id}`;
  chk.checked = isEnabled(config, id);
  head.appendChild(chk);
  head.appendChild(span("name", label));
  box.appendChild(head);

  // 主体：路径框 + 检测按钮
  const body = document.createElement("div");
  body.className = "prov-body";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.id = `prov-dir-${id}`;
  inp.placeholder = "留空自动检测";
  inp.value = cfg.configDir || "";
  const btn = document.createElement("button");
  btn.className = "probe";
  btn.type = "button";
  btn.textContent = "检测";
  body.appendChild(inp);
  body.appendChild(btn);
  box.appendChild(body);

  // 检测结果行
  const result = document.createElement("div");
  result.className = "probe-result";
  result.id = `prov-res-${id}`;
  box.appendChild(result);

  // 交互：开关切换灰显 + 全关提示；路径变化去抖检测；按钮手动检测
  const refreshDisabled = () => {
    box.classList.toggle("disabled", !chk.checked);
    updateAllOffWarn();
  };
  chk.addEventListener("change", refreshDisabled);
  const doProbe = () => probeProvider(id);
  inp.addEventListener("input", () => {
    if (probeTimers[id]) clearTimeout(probeTimers[id]);
    probeTimers[id] = setTimeout(doProbe, 400);
  });
  btn.addEventListener("click", doProbe);

  refreshDisabled();
  return box;
}

async function probeProvider(id) {
  const el = $(`prov-res-${id}`);
  if (!el) return;
  el.textContent = "";
  el.appendChild(span("src", "检测中…"));
  try {
    const dir = $(`prov-dir-${id}`).value.trim();
    const r = await window.settingsAPI.probe(id, { configDir: dir });
    renderProbe(el, r);
  } catch (e) {
    el.textContent = "";
    el.appendChild(span("bad", `✗ 检测失败：${e && e.message ? e.message : e}`));
  }
}

// 全部停用时给醒目提示（避免“全关反而全开”的误解 + 提醒不会显示任何灯）
function updateAllOffWarn() {
  const anyOn = PROVIDERS.some((p) => $(`prov-on-${p.id}`) && $(`prov-on-${p.id}`).checked);
  const el = $("allOffWarn");
  el.textContent = "";
  if (!anyOn) el.appendChild(span("bad", "⚠ 已停用所有数据源，不会显示任何灯"));
}

function init(config, providerMeta) {
  PROVIDERS = Array.isArray(providerMeta) ? providerMeta : [];

  for (const key of COLORS) {
    $(`c-${key}`).value = config.colors[key];
    syncHex(key);
  }
  $("maxDots").value = config.maxDots;
  $("workingSec").value = config.workingSec;
  $("recentSec").value = config.recentSec;
  $("barBackground").value = config.barBackground;

  // 动态建数据源行
  const host = $("providers");
  host.textContent = "";
  for (const meta of PROVIDERS) host.appendChild(buildProviderRow(meta, config));
  updateAllOffWarn();

  // 打开时对每个启用的 provider 自动检测一次，常驻显示当前解析目录
  for (const p of PROVIDERS) {
    if ($(`prov-on-${p.id}`).checked) probeProvider(p.id);
  }
}

for (const key of COLORS) {
  $(`c-${key}`).addEventListener("input", () => syncHex(key));
}

$("save").addEventListener("click", () => {
  const colors = {};
  for (const key of COLORS) colors[key] = $(`c-${key}`).value;

  // 收集数据源：勾选的 id → providers；各路径 → providerConfigs
  const providers = [];
  const providerConfigs = {};
  for (const p of PROVIDERS) {
    const on = $(`prov-on-${p.id}`);
    const dir = $(`prov-dir-${p.id}`);
    if (on && on.checked) providers.push(p.id);
    if (dir) providerConfigs[p.id] = { configDir: dir.value.trim() };
  }

  window.settingsAPI.save({
    colors,
    maxDots: $("maxDots").value,
    workingSec: $("workingSec").value,
    recentSec: $("recentSec").value,
    barBackground: $("barBackground").value.trim(),
    providers,          // 显式数组（含空数组=全关）
    providerConfigs,
  });
  window.settingsAPI.close();
});

$("cancel").addEventListener("click", () => window.settingsAPI.close());

window.settingsAPI.onInit(init);
