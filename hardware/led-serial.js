// hardware/led-serial.js
// 串口连接管理，供 Electron 主进程点亮 ESP32-C6 外设灯。
//
// 设计要点：
//  - serialport 用动态 import：缺依赖 / 未启用时整个 LED 功能静默跳过，绝不影响小条本体。
//  - 自动识别：按 ESP32-C6 的 USB VID/PID（303A:1001，Espressif 内置 USB-Serial/JTAG，固定值）挑串口。
//  - 懒连接 + 断线自愈：拔了不崩、再插自动重连（定时重扫）。
//  - 只写不读，帧编码复用 ../led-frame.js（与独立桥 serial-bridge.js 同一份映射）。

import { buildFrame, offFrame } from "./led-frame.js";

// ESP32-C6（及多数新 ESP 芯片）的 USB 厂商 ID。serialport 返回的 vendorId 是小写十六进制无前缀。
const ESP_VENDOR_ID = "303a";

// 动态加载 serialport；缺库返回 null（不抛，让上层静默降级）。
async function loadSerialPort() {
  try {
    const mod = await import("serialport");
    return mod.SerialPort;
  } catch {
    return null;
  }
}

export class LedSerial {
  /**
   * @param {Object} opts
   * @param {boolean} opts.autoPort  true=按 VID 自动挑口；false=用固定 port
   * @param {string}  opts.port      autoPort=false 时使用的串口路径（如 COM3）
   * @param {number}  opts.ledCount  LED 数量（默认 4）
   * @param {number}  opts.baud      波特率（默认 115200）
   * @param {(msg:string)=>void} [opts.log]  可选日志回调
   */
  constructor({ autoPort = true, port = "", ledCount = 4, baud = 115200, log, onChange } = {}) {
    this.autoPort = autoPort;
    this.port = port;
    this.ledCount = ledCount;
    this.baud = baud;
    this.log = typeof log === "function" ? log : () => {};
    // 连接状态变化（连上/断开）时回调，供主进程刷新托盘状态行。
    // 因为连接是异步的、发生在 tick 之间，tick 里对比 connectedPath 会漏掉这次跳变。
    this.onChange = typeof onChange === "function" ? onChange : () => {};

    this.SerialPort = null;   // 动态加载的类
    this.sp = null;           // 当前串口实例
    this.connectedPath = null;// 已连接的口（供 UI 显示）
    this.connecting = false;
    this.available = null;    // serialport 是否可用（null=未探测，false=缺库）
    this.retryTimer = null;
  }

  // 当前连接状态描述，供托盘菜单显示。
  status() {
    if (this.available === false) return "serialport 未安装";
    if (this.connectedPath) return `已连接 ${this.connectedPath}`;
    return "未连接（等待设备）";
  }

  // 自动识别：列出串口，挑第一个 VID=303a 的（ESP32-C6）。返回路径或 null。
  async detectPort() {
    if (!this.SerialPort) return null;
    let ports;
    try { ports = await this.SerialPort.list(); } catch { return null; }
    const hit = ports.find((p) => (p.vendorId || "").toLowerCase() === ESP_VENDOR_ID);
    return hit ? hit.path : null;
  }

  // 确保 serialport 已加载；只探测一次。
  async ensureLib() {
    if (this.available !== null) return this.available;
    this.SerialPort = await loadSerialPort();
    this.available = this.SerialPort != null;
    if (!this.available) this.log("serialport 未安装，外设灯功能不可用（可 npm i serialport）");
    return this.available;
  }

  // 尝试连接（懒连接）。已连接则直接返回。失败不抛，交给下一轮 push 重试。
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
      this.log(`外设灯已连接 ${target} @ ${this.baud}`);
      this.onChange(); // 连上：通知主进程刷新托盘状态行（这次跳变发生在 tick 之间，靠回调而非轮询捕捉）

      // 断线处理：清空状态，交给下一轮自动重连。
      const onGone = () => {
        if (this.sp === sp) {
          this.sp = null;
          this.connectedPath = null;
          this.log("外设灯串口断开，将自动重连");
          this.onChange(); // 断开：通知主进程刷新状态行
        }
      };
      sp.on("close", onGone);
      sp.on("error", onGone);
      return true;
    } catch (e) {
      this.log(`外设灯连接失败: ${e.message}`);
      this.sp = null;
      this.connectedPath = null;
      return false;
    } finally {
      this.connecting = false;
    }
  }

  // 每轮扫描调用：把 rows 编码成帧写串口。未连接则尝试连接（不阻塞主循环——connect 是异步，忽略其 promise）。
  push(rows) {
    if (this.sp && this.sp.writable) {
      try { this.sp.write(buildFrame(rows, this.ledCount)); } catch {}
      return;
    }
    // 未连接：异步尝试连接，本轮不发（下一轮 refreshMs 再发）。不 await，避免拖慢 tick。
    this.connect();
  }

  // 关闭：发一帧全灭再关口。
  async close() {
    const sp = this.sp;
    this.sp = null;
    this.connectedPath = null;
    if (!sp) return;
    try { if (sp.writable) sp.write(offFrame(this.ledCount)); } catch {}
    await new Promise((resolve) => {
      try { sp.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 300); // 兜底：close 回调不来也别卡退出
    });
  }
}
