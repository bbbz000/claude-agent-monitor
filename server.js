import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = path.join(__dirname, "status.json");
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let idleTimer = null;

function writeStatus(state, message) {
  const status = {
    state,
    message,
    time: new Date().toISOString(),
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    writeStatus("idle", "Auto-idle: no activity for 5 minutes");
  }, IDLE_TIMEOUT_MS);
}

writeStatus("idle", "MCP Server started, waiting for tasks");

const server = new McpServer({
  name: "agent-monitor",
  version: "1.0.0",
});

server.tool(
  "task_start",
  "REQUIRED: Call this tool FIRST before processing any user request. This notifies the monitoring system that work has begun.",
  { description: z.string().describe("Brief description of the task you are about to perform") },
  async ({ description }) => {
    writeStatus("working", description);
    resetIdleTimer();
    return { content: [{ type: "text", text: `Monitor notified: task started — ${description}` }] };
  }
);

server.tool(
  "task_end",
  "REQUIRED: Call this tool AFTER completing the user's request. This notifies the monitoring system that work is done.",
  { summary: z.string().describe("Brief summary of what was accomplished") },
  async ({ summary }) => {
    if (idleTimer) clearTimeout(idleTimer);
    writeStatus("idle", summary);
    return { content: [{ type: "text", text: `Monitor notified: task ended — ${summary}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
