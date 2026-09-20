// electron/virtual-desktops.js
// 读 Windows 虚拟桌面的「总数 + 当前序号 + 每个桌面的名字」，供屏幕板顶栏显示成一排胶囊。
//
// 为什么读注册表而非 COM：公开的 IVirtualDesktopManager 只能判断「某窗口在不在当前桌面」，
// 给不了总数/序号/名字；能给的 IVirtualDesktopManagerInternal 是私有接口，GUID 每个 Win 版本
// 都变、极脆。而 Explorer 把虚拟桌面状态明文存在注册表里，读它零依赖、跨 Win10/11 稳定：
//
//   HKCU\...\Explorer\VirtualDesktops\VirtualDesktopIDs
//     REG_BINARY：一串 16 字节 GUID 拼接，每 16 字节=一个桌面，顺序即桌面顺序 → 总数=字节数/16
//   当前桌面 GUID（按 Win 版本存在不同位置，下面按优先级兜底）：
//     HKCU\...\Explorer\SessionInfo\<sid>\VirtualDesktops\CurrentVirtualDesktop （Win11/较新 Win10）
//     HKCU\...\Explorer\VirtualDesktops\CurrentVirtualDesktop                   （老 Win10 兜底）
//   每个桌面的名字（仅「改过名」的桌面才有此子键；没改过名的读不到 → 兜底「桌面N」）：
//     HKCU\...\Explorer\VirtualDesktops\Desktops\{GUID}\Name  (REG_SZ，可含中文)
//
// 两个坑（均已实测处理）：
//  1. GUID 两种格式：VirtualDesktopIDs 是紧凑 hex（前三段小端字节序），Desktops 子键是标准
//     带括号大写格式。要按 GUID 取名字，必须把紧凑 hex 转成标准格式（hexToGuid）。
//  2. 中文名：reg query 的控制台编码会把中文输出成 ????；名字改用 PowerShell 强制 UTF-8 输出
//     JSON 才正确。PowerShell 启动有几百 ms 开销，故名字低频节流刷新，不拖累每秒的序号采样。
//
// 非 Windows 或读不到 → 返回 null，上层据此省略字段、固件不画。

import { execFile } from "child_process";

const EXPLORER = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer";
const VD_KEY = `${EXPLORER}\\VirtualDesktops`;
const SESSINFO = `${EXPLORER}\\SessionInfo`;
const NAMES_TTL_MS = 10000;   // 名字映射最多每 10s 用 PowerShell 刷一次（改名/增删桌面才变，低频足够）

// reg query 一个 REG_BINARY 值 → 小写 hex 字符串（无空格）。缺键/出错 → null。
function regBinary(key, value) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", value], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = stdout.match(/REG_BINARY\s+([0-9A-Fa-f]+)/); // 行形如： <value>  REG_BINARY  <hex>
      resolve(m ? m[1].toLowerCase() : null);
    });
  });
}

// 枚举 SessionInfo 下的会话子键名（如 "1"）。用于定位当前会话的 CurrentVirtualDesktop。
function sessionIds() {
  return new Promise((resolve) => {
    execFile("reg", ["query", SESSINFO], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const ids = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/\\SessionInfo\\(\d+)\s*$/);
        if (m) ids.push(m[1]);
      }
      resolve(ids);
    });
  });
}

// 把 VirtualDesktopIDs 里的紧凑 16 字节 hex 转成标准带括号大写 GUID，用于匹配 Desktops 子键。
// GUID 前三段（Data1 4B / Data2 2B / Data3 2B）以小端存储，需按字节反转；后 8 字节原样。
//   3703661548 29 904F 93ED A7E4A3EAC0C9 → {15660337-2948-4F90-93ED-A7E4A3EAC0C9}
function hexToGuid(hex) {
  if (!hex || hex.length !== 32) return null;
  const b = hex.match(/../g); // 16 个字节
  const rev = (lo, hi) => b.slice(lo, hi).reverse().join(""); // 小端字节反转
  const d1 = rev(0, 4);
  const d2 = rev(4, 6);
  const d3 = rev(6, 8);
  const d4 = b.slice(8, 10).join("");
  const d5 = b.slice(10, 16).join("");
  return `{${d1}-${d2}-${d3}-${d4}-${d5}}`.toUpperCase();
}

// 读当前桌面 GUID（紧凑 hex）。先试各会话下的 SessionInfo 路径，再兜底老 Win10 的直接路径。
// 多会话时用「必须是 IDs 列表成员」消歧：只有真正属于本机桌面列表的那个才算数。
async function currentGuid(idList) {
  const sids = await sessionIds();
  for (const sid of sids) {
    const g = await regBinary(`${SESSINFO}\\${sid}\\VirtualDesktops`, "CurrentVirtualDesktop");
    if (g && idList.includes(g)) return g;
    if (g && idList.length === 0) return g;
  }
  return regBinary(VD_KEY, "CurrentVirtualDesktop"); // 老 Win10：当前 GUID 直接存在 VirtualDesktops 下
}

// 用 PowerShell 读 Desktops\{GUID}\Name 映射（标准大写 GUID → 名字）。强制 UTF-8 输出 JSON，
// 否则中文名乱码。没有 Desktops 键/无改名桌面 → 返回空映射 {}。出错 → null（上层保留旧缓存）。
function readNameMap() {
  const ps = [
    "$OutputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    `$d='HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops\\Desktops';`,
    "if(Test-Path $d){ Get-ChildItem $d | ForEach-Object { [PSCustomObject]@{ id=$_.PSChildName; name=$_.GetValue('Name') } } | ConvertTo-Json -Compress } else { '[]' }",
  ].join(" ");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          let j = JSON.parse(stdout.trim());
          if (!Array.isArray(j)) j = j ? [j] : []; // ConvertTo-Json 单元素不套数组
          const map = {};
          for (const e of j) if (e && e.id && e.name) map[String(e.id).toUpperCase()] = String(e.name);
          resolve(map);
        } catch { resolve(null); }
      });
  });
}

// ── 名字映射缓存（低频刷新）─────────────────────────
let nameMap = {};          // 标准大写 GUID → 名字
let nameMapAt = 0;         // 上次刷新时间戳
let nameInflight = false;
async function refreshNamesIfStale() {
  if (nameInflight || Date.now() - nameMapAt < NAMES_TTL_MS) return;
  nameInflight = true;
  try {
    const m = await readNameMap();
    if (m) { nameMap = m; nameMapAt = Date.now(); }
  } catch { /* 保留旧缓存 */ }
  finally { nameInflight = false; }
}

/**
 * 读虚拟桌面信息。
 * @returns {Promise<{current:number,total:number,names:string[]}|null>}
 *   current：当前桌面序号（1 起）；total：总数；names：按桌面顺序的名字数组
 *   （改过名的用真实名，没改过名的兜底「桌面N」）。读不到/非 Windows → null。
 */
export async function readVirtualDesktops() {
  if (process.platform !== "win32") return null;
  const idsHex = await regBinary(VD_KEY, "VirtualDesktopIDs");
  if (!idsHex || idsHex.length < 32) return null;

  const list = []; // 有序紧凑 hex
  for (let i = 0; i + 32 <= idsHex.length; i += 32) list.push(idsHex.slice(i, i + 32));
  const total = list.length;
  if (total === 0) return null;

  const cur = await currentGuid(list);
  const idx = cur ? list.indexOf(cur) : -1;
  const current = idx >= 0 ? idx + 1 : 1;

  refreshNamesIfStale(); // 触发名字低频刷新（异步，不 await；本轮先用现有缓存）
  const names = list.map((hex, i) => {
    const guid = hexToGuid(hex);
    return (guid && nameMap[guid]) || `桌面${i + 1}`; // 没改过名 → 兜底「桌面N」
  });

  return { current, total, names };
}

// ── 缓存 + 异步轮询 ───────────────────────────────────
// 采样跑在主进程 1s 定时器上；序号用轻量 reg query，名字低频 PowerShell 刷新，都不在推帧路径
// 同步阻塞：poll() 异步刷缓存，推帧时用 get() 读缓存（同步、零延迟）。
let cache = null;
let inflight = false;

export function poll() {
  if (inflight) return;
  inflight = true;
  readVirtualDesktops()
    .then((v) => { cache = v; })
    .catch(() => { /* 保留上次缓存，避免读抖动闪烁 */ })
    .finally(() => { inflight = false; });
}

export function get() {
  return cache;
}
