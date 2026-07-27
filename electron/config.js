// electron/config.js
// config.json 读写：defaults + 原子写 + displayId 校验。不引入 electron-store，fs+JSON 足够。
import fs from "fs";
import path from "path";

export function getDefaults() {
  return {
    displayId: null,                 // null = 主显示器；否则为 screen display.id
    configDir: "",                   // Claude 配置目录（.claude 根）覆盖；空=自动（CLAUDE_CONFIG_DIR / 默认 ~/.claude）
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
  };
}

// 深合并（仅一层嵌套 colors/offset 需要合并），保证旧 config 缺字段时用默认补齐
function mergeDefaults(saved) {
  const d = getDefaults();
  if (!saved || typeof saved !== "object") return d;
  return {
    ...d,
    ...saved,
    colors: { ...d.colors, ...(saved.colors || {}) },
    offset: { ...d.offset, ...(saved.offset || {}) },
  };
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
