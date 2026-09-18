#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasAdb, reversePort } from "./android.js";
import { AppConnection } from "./app.js";
import { registerTools } from "./tools.js";

const port = Number(process.env.AGENT_JET_PORT ?? 8765);
const app = new AppConnection(port);
if (await hasAdb()) await reversePort(port);
const pkg = createRequire(import.meta.url)("../../package.json") as { name: string; version: string };
const server = new McpServer({ name: pkg.name, version: pkg.version });
registerTools(server, app);
const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
process.stdin.on("end", () => process.exit(0));
await server.connect(transport);
process.stderr.write(`[agent-jet-mcp] listening for the app on ws://localhost:${port}\n`);
