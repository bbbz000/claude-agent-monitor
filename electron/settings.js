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
// 每个 provider 的配置控件由它自己的 configSchema 声明，这里按 field.type 通用渲染。
let PROVIDERS = []; // [{id,label,configSchema,hasProbe}]
const probeTimers = {};

function isEnabled(config, id) {
  if (config.providers == null) return true; // null = 全启用
  return config.providers.includes(id);
}

// 字段控件 id：prov-f-<provId>-<fieldKey>，全局唯一，供收集/检测时读值
const fieldId = (provId, key) => `prov-f-${provId}-${key}`;

// 按 field.type 建一个控件（不含 label）。值一律按字符串处理。
function buildField(provId, field, value) {
  let el;
  if (field.type === "select") {
    el = document.createElement("select");
    for (const opt of field.options || []) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label != null ? opt.label : opt.value; // textContent 防注入
      el.appendChild(o);
    }
    el.value = value != null ? value : "";
  } else {
    el = document.createElement("input");
    // path/text → text；secret → password（打码）
    el.type = field.type === "secret" ? "password" : "text";
    if (field.placeholder) el.placeholder = field.placeholder;
    el.value = value != null ? value : "";
  }
  el.id = fieldId(provId, field.key);
  el.dataset.key = field.key;
  return el;
}

// 收集某 provider 当前所有字段的值 → { key: value }
function collectProviderValues(meta) {
  const out = {};
  for (const f of meta.configSchema || []) {
    const el = $(fieldId(meta.id, f.key));
    if (el) out[f.key] = (el.value || "").trim();
  }
  return out;
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

  // 主体：按 configSchema 逐字段渲染「标签 + 控件」
  const body = document.createElement("div");
  body.className = "prov-body";
  for (const field of meta.configSchema || []) {
    const fieldRow = document.createElement("div");
    fieldRow.className = "prov-field";
    if (field.label) fieldRow.appendChild(span("flabel", field.label));
    fieldRow.appendChild(buildField(id, field, cfg[field.key]));
    body.appendChild(fieldRow);
  }
  box.appendChild(body);

  // 检测：整个 provider 一个按钮（把全字段打包给 probe）。provider 未实现 probe → 不画。
  if (meta.hasProbe) {
    const probeRow = document.createElement("div");
    probeRow.className = "prov-probe";
    const btn = document.createElement("button");
    btn.className = "probe";
    btn.type = "button";
    btn.textContent = "检测";
    probeRow.appendChild(btn);
    box.appendChild(probeRow);

    const result = document.createElement("div");
    result.className = "probe-result";
    result.id = `prov-res-${id}`;
    box.appendChild(result);

    const doProbe = () => probeProvider(id);
    btn.addEventListener("click", doProbe);
    // 字段变化去抖自动检测
    for (const field of meta.configSchema || []) {
      const el = $(fieldId(id, field.key));
      if (!el) continue;
      const evt = field.type === "select" ? "change" : "input";
      el.addEventListener(evt, () => {
        if (probeTimers[id]) clearTimeout(probeTimers[id]);
        probeTimers[id] = setTimeout(doProbe, 400);
      });
    }
  }

  // 开关切换灰显 + 全关提示
  const refreshDisabled = () => {
    box.classList.toggle("disabled", !chk.checked);
    updateAllOffWarn();
  };
  chk.addEventListener("change", refreshDisabled);
  refreshDisabled();
  return box;
}

async function probeProvider(id) {
  const el = $(`prov-res-${id}`);
  if (!el) return;
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) return;
  el.textContent = "";
  el.appendChild(span("src", "检测中…"));
  try {
    const values = collectProviderValues(meta); // 整包字段传给 probe
    const r = await window.settingsAPI.probe(id, values);
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

  // 收集数据源：勾选的 id → providers；各字段 → providerConfigs[id]
  const providers = [];
  const providerConfigs = {};
  for (const p of PROVIDERS) {
    const on = $(`prov-on-${p.id}`);
    if (on && on.checked) providers.push(p.id);
    providerConfigs[p.id] = collectProviderValues(p); // { [fieldKey]: value }
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
