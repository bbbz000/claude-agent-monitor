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
  // 鼠标悬停到第 index 个圆点：上报索引 + 圆点中心的窗口内 X 坐标（DIP）
  hover: (payload) => ipcRenderer.send("tip:hover", payload),
  // 移出圆点：请求隐藏气泡
  unhover: () => ipcRenderer.send("tip:unhover"),
});

// 悬停气泡窗专用桥：接收 main 推来的单个 agent 详情
contextBridge.exposeInMainWorld("tip", {
  onData: (cb) => ipcRenderer.on("tip:data", (_e, data) => cb(data)),
});

// 设置窗口专用桥
contextBridge.exposeInMainWorld("settingsAPI", {
  onInit: (cb) => ipcRenderer.on("settings:init", (_e, config) => cb(config)),
  save: (config) => ipcRenderer.send("settings:save", config),
  close: () => ipcRenderer.send("settings:close"),
});
