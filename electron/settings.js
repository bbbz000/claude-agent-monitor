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
  $("barBackground").value = config.barBackground;
}

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
    barBackground: $("barBackground").value.trim(),
  });
  window.settingsAPI.close();
});

$("cancel").addEventListener("click", () => window.settingsAPI.close());

window.settingsAPI.onInit(init);
