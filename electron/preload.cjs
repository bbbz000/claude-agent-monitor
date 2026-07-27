// electron/preload.cjs
// 最小安全桥：contextIsolation:true + nodeIntegration:false 下，
// renderer 只能通过这里暴露的 window.bar 访问受控能力。不暴露 fs/require。
// 【必须是 .cjs】否则 package.json 的 type:module 会把它当 ESM，require 报错。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bar", {
  // 主进程每次扫描后推送状态数组，如 ["WORKING","DONE",...]
  onAgents: (cb) => ipcRenderer.on("agents:update", (_e, states) => cb(states)),
  // 主进程推送配置（颜色/maxDots/背景等）
  onConfig: (cb) => ipcRenderer.on("config:update", (_e, config) => cb(config)),
});

// 设置窗口专用桥
contextBridge.exposeInMainWorld("settingsAPI", {
  onInit: (cb) => ipcRenderer.on("settings:init", (_e, config) => cb(config)),
  save: (config) => ipcRenderer.send("settings:save", config),
  close: () => ipcRenderer.send("settings:close"),
});
