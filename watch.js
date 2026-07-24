import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(__dirname, "status.json");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function printStatus(status) {
  const time = formatTime(status.time);
  if (status.state === "working") {
    console.log(
      `${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.yellow}${COLORS.bold}● WORKING${COLORS.reset}  ${status.message}`
    );
  } else {
    console.log(
      `${COLORS.dim}[${time}]${COLORS.reset} ${COLORS.green}${COLORS.bold}○ IDLE${COLORS.reset}     ${status.message}`
    );
  }
}

console.log(`${COLORS.cyan}╔══════════════════════════════════════╗${COLORS.reset}`);
console.log(`${COLORS.cyan}║   Claude Agent Monitor - Watcher    ║${COLORS.reset}`);
console.log(`${COLORS.cyan}╚══════════════════════════════════════╝${COLORS.reset}`);
console.log(`${COLORS.dim}Watching: ${STATUS_FILE}${COLORS.reset}`);
console.log(`${COLORS.dim}Press Ctrl+C to exit${COLORS.reset}`);
console.log();

if (fs.existsSync(STATUS_FILE)) {
  try {
    const current = JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
    console.log(`${COLORS.dim}Current status:${COLORS.reset}`);
    printStatus(current);
    console.log();
  } catch {}
}

let lastContent = "";

fs.watch(STATUS_FILE, { persistent: true }, () => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf-8");
    if (raw === lastContent) return;
    lastContent = raw;
    const status = JSON.parse(raw);
    printStatus(status);
  } catch {}
});

if (!fs.existsSync(STATUS_FILE)) {
  console.log(`${COLORS.dim}Waiting for MCP Server to create status.json...${COLORS.reset}`);
  const dir = path.dirname(STATUS_FILE);
  fs.watch(dir, (_, filename) => {
    if (filename === "status.json" && fs.existsSync(STATUS_FILE)) {
      try {
        const raw = fs.readFileSync(STATUS_FILE, "utf-8");
        lastContent = raw;
        printStatus(JSON.parse(raw));
      } catch {}
    }
  });
}

process.on("SIGINT", () => {
  console.log(`\n${COLORS.dim}Watcher stopped.${COLORS.reset}`);
  process.exit(0);
});
