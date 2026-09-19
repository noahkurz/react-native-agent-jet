import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UINode } from "../../src/protocol.js";
import type { AppConnection } from "../app.js";
import { registerInspectTools } from "./inspect.js";
import { registerInteractTools } from "./interact.js";
import { registerSessionTools } from "./session.js";
import type { ToolContext } from "./shared.js";

export function registerTools(server: McpServer, app: AppConnection) {
	const context: ToolContext = { app, lastTree: new Map<string, UINode[]>() };
	registerInspectTools(server, context);
	registerInteractTools(server, context);
	registerSessionTools(server, context);
}
