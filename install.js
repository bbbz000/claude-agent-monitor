import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(os.homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json");
const SERVER_PATH = path.join(__dirname, "server.js").replace(/\\/g, "\\\\");

console.log("Claude Agent Monitor - Installer\n");

let config = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    console.log(`[OK] Found existing config: ${CONFIG_PATH}`);
  } catch (e) {
    console.error(`[ERR] Failed to parse config: ${e.message}`);
    process.exit(1);
  }
} else {
  console.log(`[INFO] Config not found, will create: ${CONFIG_PATH}`);
}

if (!config.mcpServers) {
  config.mcpServers = {};
}

if (config.mcpServers["agent-monitor"]) {
  console.log("[INFO] agent-monitor already configured, updating...");
}

config.mcpServers["agent-monitor"] = {
  command: "node",
  args: [path.join(__dirname, "server.js")],
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log(`[OK] MCP Server configured successfully`);
console.log(`\nNext steps:`);
console.log(`  1. Restart Claude Desktop`);
console.log(`  2. Run: node watch.js`);
console.log(`  3. Send a message in Claude Desktop and watch the status`);
console.log(`\nOptional: Add this to Claude Desktop's Custom Instructions (Settings > Custom Instructions):`);
console.log(`  "Every time you begin processing a user request, call the task_start tool first.`);
console.log(`   When you finish, call task_end."`);
