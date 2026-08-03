// electron/config.js
// config.json 读写：defaults + 原子写 + displayId 校验。不引入 electron-store，fs+JSON 足够。
import fs from "fs";
import path from "path";

export function getDefaults() {
  return {
    displayId: null,                 // null = 主显示器；否则为 screen display.id
    providers: null,                 // 启用的 provider id 列表；null=全部启用（首次/旧配置），[]=全关
    providerConfigs: {               // 各 provider 各自的配置，形状由 provider 定义
      claude: { configDir: "" },     //   Claude 的 .claude 根覆盖；空=自动
      opencode: { logPath: "" },     //   OpenCode 的 opencode.log 路径覆盖；空=自动（~/.local/share/opencode/log）
    },
    position: "workarea-bottom-right", // 默认贴任务栏正上方（不与任务栏抢层级，最稳）
    draggable: false,                // 是否允许自由拖动（唯一开关；true 时才可拖 + 走 free 定位）
    freePos: null,                   // 自由模式（拖动后）记住的锚点 {right,y}（右边缘+顶边）；draggable 时生效
    offset: { x: -12, y: 0 },        // 相对定位锚点的像素微调（x 通常为负，向左让出右边距）
    colors: {
      WORKING: "#22c55e",            // 绿：正在运行
      WAITING: "#f97316",            // 橙红：等你确认/回答（AskUserQuestion/退出计划）
      DONE: "#06b6d4",               // 青：已回复
      RECENT: "#eab308",             // 黄：近期
      EMPTY: "#6b7280",              // 灰：无活跃占位
    },
    maxDots: 12,                     // 超过则折叠成 …+N
    workingSec: 30,
    recentSec: 300,
    barBackground: "rgba(0,0,0,0.35)", // 胶囊背景；设为 "transparent" 可关闭
    refreshMs: 2000,
    hardware: {                        // 外设灯（ESP32-C6 RGB LED）；默认关，不影响纯软件用户
      enabled: false,                  //   总开关
      autoPort: true,                  //   true=按 USB VID(303a) 自动挑串口；false=用下面 port
      port: "",                        //   autoPort=false 时的固定串口（如 COM3）
      ledCount: 4,                     //   LED 数量
    },
  };
}

// 深合并（colors/offset/providerConfigs 需一层合并），保证旧 config 缺字段时用默认补齐。
// 同时做旧配置迁移：顶层 configDir → providerConfigs.claude.configDir（用户无感）。
function mergeDefaults(saved) {
  const d = getDefaults();
  if (!saved || typeof saved !== "object") return d;
  // providerConfigs 通用合并：逐 provider 浅合并（不写死某个 provider 一层），
  // 各 provider 的字段形状由其 configSchema 决定，这里不假设有哪些键。
  const mergedProviderConfigs = { ...d.providerConfigs };
  const savedPC = (saved.providerConfigs && typeof saved.providerConfigs === "object") ? saved.providerConfigs : {};
  for (const id of Object.keys(savedPC)) {
    mergedProviderConfigs[id] = { ...(mergedProviderConfigs[id] || {}), ...(savedPC[id] || {}) };
  }
  const merged = {
    ...d,
    ...saved,
    colors: { ...d.colors, ...(saved.colors || {}) },
    offset: { ...d.offset, ...(saved.offset || {}) },
    hardware: { ...d.hardware, ...(saved.hardware || {}) },
    providerConfigs: mergedProviderConfigs,
  };
  // 迁移：旧版把 Claude 目录存在顶层 configDir。若新版字段缺失，则搬进 providerConfigs.claude。
  if (typeof saved.configDir === "string" && saved.configDir.trim() &&
      !(saved.providerConfigs && saved.providerConfigs.claude && saved.providerConfigs.claude.configDir)) {
    merged.providerConfigs.claude = { ...(merged.providerConfigs.claude || {}), configDir: saved.configDir.trim() };
  }
  delete merged.configDir; // 顶层 configDir 不再保留，统一走 providerConfigs
  return merged;
}

export function configPath(userDataDir) {
  return path.join(userDataDir, "config.json");
}

export function load(userDataDir) {
  const fp = configPath(userDataDir);
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    return mergeDefaults(JSON.parse(raw));
  } catch {
    return getDefaults(); // 首次运行 / 读失败 → 默认
  }
}

// 原子写：临时文件 + rename，避免写一半损坏
export function save(userDataDir, config) {
  const fp = configPath(userDataDir);
  const tmp = fp + ".tmp";
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmp, fp);
    return true;
  } catch (e) {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

// 校验 displayId 是否仍存在于当前显示器列表；失效则回退主屏（但不覆盖存储，便于插回恢复）
export function resolveDisplay(config, displays, primary) {
  if (config.displayId == null) return primary;
  const found = displays.find((d) => d.id === config.displayId);
  return found || primary;
}
