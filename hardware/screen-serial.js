// hardware/screen-serial.js
// 串口连接管理，供 Electron 主进程把监控信息推到 ESP32-S3-RLCD-4.2 屏幕板。
//
// 设计与 hardware/led-serial.js 同构（自动识别 VID / 懒连接 / 断线自愈 / 只写不读），
// 差别只在帧编码：屏幕板收的是每帧一行 JSON（见 screen-frame.js / SCREEN_PROTOCOL.md）。
//
// 两块板同插的现实问题：LED 板(ESP32-C6)与屏幕板(ESP32-S3)的 USB VID 都是 303a，
// SerialPort.list() 无法只凭 VID 区分。若两块都要用，请给屏幕设备关掉 autoPort、指定固定 COM 口。

import { buildScreenFrame, offScreenFrame, DEFAULT_MAX_SESSIONS } from "./screen-frame.js";

// 认得的 USB 串口 VID（小写十六进制无前缀）：
//   303a = Espressif 原生 USB（ESP32-S3/C6/C3 内置 USB-Serial/JTAG）
//   1a86 = 沁恒 WCH（CH340 / CH9102）
//   10c4 = Silicon Labs（CP2102/CP2104）
const ESP_VENDOR_IDS = ["303a", "1a86", "10c4"];

// 动态加载 serialport；缺库返回 null（不抛，让上层静默降级——与 LED 一致）。
async function loadSerialPort() {
  try {
    const mod = await import("serialport");
    return mod.SerialPort;
  } catch {
    return null;
  }
}

export class ScreenSerial {
  /**
   * @param {Object} opts
   * @param {boolean} opts.autoPort     true=按 USB VID 自动挑串口；false=用固定 port
   * @param {string}  opts.port         autoPort=false 时使用的串口路径（如 COM7）
   * @param {number}  opts.maxSessions  最多显示几条会话（默认 6）
   * @param {number}  opts.baud         波特率（默认 115200）
   * @param {(msg:string)=>void} [opts.log]     可选日志回调
   * @param {()=>void} [opts.onChange]          连/断跳变回调（刷新托盘状态行）
   */
  constructor({ autoPort = true, port = "", maxSessions = DEFAULT_MAX_SESSIONS, baud = 115200, log, onChange } = {}) {
    this.autoPort = autoPort;
    this.port = port;
    this.maxSessions = maxSessions;
    this.baud = baud;
    this.log = typeof log === "function" ? log : () => {};
    this.onChange = typeof onChange === "function" ? onChange : () => {};

    this.SerialPort = null;    // 动态加载的类
    this.sp = null;            // 当前串口实例
    this.connectedPath = null; // 已连接的口（供 UI 显示）
    this.connecting = false;
    this.available = null;     // serialport 是否可用（null=未探测，false=缺库）
  }

  // 当前连接状态描述，供托盘菜单显示。
  status() {
    if (this.available === false) return "serialport 未安装";
    if (this.connectedPath) return `已连接 ${this.connectedPath}`;
    return "未连接（等待设备）";
  }

  // 自动识别：列出串口，挑第一个 VID 命中白名单的。返回路径或 null。
  async detectPort() {
    if (!this.SerialPort) return null;
    let ports;
    try { ports = await this.SerialPort.list(); } catch { return null; }
    const hit = ports.find((p) => ESP_VENDOR_IDS.includes((p.vendorId || "").toLowerCase()));
    return hit ? hit.path : null;
  }

  // 确保 serialport 已加载；只探测一次。
  async ensureLib() {
    if (this.available !== null) return this.available;
    this.SerialPort = await loadSerialPort();
    this.available = this.SerialPort != null;
    if (!this.available) this.log("serialport 未安装，屏幕功能不可用（可 npm i serialport）");
    return this.available;
  }

  // 尝试连接（懒连接）。已连接直接返回。失败不抛，交给下一轮 push 重试。
  async connect() {
    if (this.sp && this.sp.writable) return true;
    if (this.connecting) return false;
    this.connecting = true;
    try {
      if (!(await this.ensureLib())) return false;

      const target = this.autoPort ? await this.detectPort() : (this.port || null);
      if (!target) return false; // 没插设备 / 没配置口 → 静默等下一轮

      await new Promise((resolve, reject) => {
        const sp = new this.SerialPort({ path: target, baudRate: this.baud }, (err) => {
          if (err) reject(err); else resolve();
        });
        this._pending = sp;
      });

      const sp = this._pending;
      this._pending = null;
      this.sp = sp;
      this.connectedPath = target;
      this.log(`屏幕已连接 ${target} @ ${this.baud}`);
      this.onChange();

      const onGone = () => {
        if (this.sp === sp) {
          this.sp = null;
          this.connectedPath = null;
          this.log("屏幕串口断开，将自动重连");
          this.onChange();
        }
      };
      sp.on("close", onGone);
      sp.on("error", onGone);
      return true;
    } catch (e) {
      this.log(`屏幕连接失败: ${e.message}`);
      this.sp = null;
      this.connectedPath = null;
      return false;
    } finally {
      this.connecting = false;
    }
  }

  // 每轮扫描调用：把 rows + 系统指标编码成一帧 JSON 写串口。未连接则异步尝试连接（不阻塞主循环）。
  // @param {Array} rows        scan() 完整结果
  // @param {Object} metrics    { t?:string, cpu?:number, mem?:number }
  push(rows, metrics = {}) {
    if (this.sp && this.sp.writable) {
      // write 失败以前是静默 try/catch，间歇性"屏幕冻住"时看不到任何线索。
      // 现在记日志（diag 模式可见），并把返回 false（内核写缓冲满）也报出来，便于定位丢帧。
      try {
        const ok = this.sp.write(buildScreenFrame(rows, metrics, this.maxSessions));
        if (ok === false) this.log("屏幕串口写缓冲满（write 返回 false），本帧可能延迟");
      } catch (e) {
        this.log(`屏幕串口写失败: ${e.message}`);
      }
      return;
    }
    this.connect(); // 未连接：异步尝试连接，本轮不发（下一轮再发）。不 await，避免拖慢 tick。
  }

  // 关闭：发一帧全清再关口。
  async close() {
    const sp = this.sp;
    this.sp = null;
    this.connectedPath = null;
    if (!sp) return;
    try { if (sp.writable) sp.write(offScreenFrame()); } catch {}
    await new Promise((resolve) => {
      try { sp.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 300); // 兜底：close 回调不来也别卡退出
    });
  }
}
