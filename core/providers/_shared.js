// core/providers/_shared.js
// provider 之间可复用的纯只读小工具（读文件头/尾、抽文本）。无副作用、不认识任何客户端格式。
import fs from "fs";

// 只读文件头部若干字节，避免把上百 KB 的会话整个载入
export function readHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf-8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// 只读文件尾部若干字节（size 为文件总字节数）
export function readTail(file, size, bytes = 8192) {
  const want = Math.min(size, bytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

// content 可能是字符串或 [{text},...] 数组，统一抽成纯文本
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return "";
}
