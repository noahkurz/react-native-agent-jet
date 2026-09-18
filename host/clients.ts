import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { SERVER_KEY } from "./constants.js";

export type ClientId = "claude" | "cursor" | "vscode" | "codex" | "windsurf" | "gemini" | "zed";

type Scope = "project" | "global";

type ClientSpec = {
	id: ClientId;
	label: string;
	scope: Scope;
	format: "json" | "toml";
	/** Where the config lives, given the project root. */
	file: (cwd: string) => string;
	/** JSON only: the top-level key that holds the server map. */
	key?: string;
	/** JSON only: the server entry to write, given the resolved server path. */
	entry?: (serverPath: string) => Record<string, unknown>;
};

const nodeEntry =
	(extra: Record<string, unknown> = {}) =>
	(serverPath: string) => ({ command: "node", args: [serverPath], ...extra });

export const CLIENTS: Record<ClientId, ClientSpec> = {
	claude: {
		id: "claude",
		label: "Claude Code",
		scope: "project",
		format: "json",
		file: (cwd) => join(cwd, ".mcp.json"),
		key: "mcpServers",
		entry: nodeEntry(),
	},
	cursor: {
		id: "cursor",
		label: "Cursor",
		scope: "project",
		format: "json",
		file: (cwd) => join(cwd, ".cursor", "mcp.json"),
		key: "mcpServers",
		entry: nodeEntry(),
	},
	vscode: {
		id: "vscode",
		label: "VS Code (Copilot)",
		scope: "project",
		format: "json",
		file: (cwd) => join(cwd, ".vscode", "mcp.json"),
		key: "servers",
		entry: nodeEntry({ type: "stdio" }),
	},
	gemini: {
		id: "gemini",
		label: "Gemini CLI",
		scope: "project",
		format: "json",
		file: (cwd) => join(cwd, ".gemini", "settings.json"),
		key: "mcpServers",
		entry: nodeEntry(),
	},
	zed: {
		id: "zed",
		label: "Zed",
		scope: "project",
		format: "json",
		file: (cwd) => join(cwd, ".zed", "settings.json"),
		key: "context_servers",
		entry: (serverPath) => ({ source: "custom", command: "node", args: [serverPath] }),
	},
	windsurf: {
		id: "windsurf",
		label: "Windsurf",
		scope: "global",
		format: "json",
		file: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
		key: "mcpServers",
		entry: nodeEntry(),
	},
	codex: {
		id: "codex",
		label: "Codex CLI",
		scope: "global",
		format: "toml",
		file: () => join(homedir(), ".codex", "config.toml"),
	},
};

export function resolveClient(name: string): ClientId | null {
	const key = name.toLowerCase();
	return (Object.keys(CLIENTS) as ClientId[]).find((id) => id === key) ?? null;
}

function serverPathFor(spec: ClientSpec, cwd: string, packageDir: string): string {
	const absolute = join(packageDir, "dist", "host", "mcp.js");
	if (spec.scope === "global") return absolute;
	return relative(cwd, absolute).split("\\").join("/");
}

/** Matches the `[mcp_servers.jet]` table this tool owns, so re-running init is a no-op. */
export function tomlTablePattern(): RegExp {
	return new RegExp(`\\[mcp_servers\\.${SERVER_KEY}\\]`);
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

async function writeToml(path: string, serverPath: string): Promise<"written" | "present"> {
	const existing = existsSync(path) ? await readFile(path, "utf8") : "";
	if (tomlTablePattern().test(existing)) return "present";
	const block = `\n[mcp_servers.${SERVER_KEY}]\ncommand = "node"\nargs = [${tomlString(serverPath)}]\n`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, existing ? `${existing.trimEnd()}\n${block}` : block.trimStart());
	return "written";
}

async function writeJson(spec: ClientSpec, path: string, serverPath: string): Promise<"written" | "present"> {
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		} catch {
			throw new Error(`${path} is not valid JSON; fix or remove it and rerun`);
		}
	}
	const map = (config[spec.key!] ?? {}) as Record<string, unknown>;
	const already = SERVER_KEY in map;
	map[SERVER_KEY] = spec.entry!(serverPath);
	config[spec.key!] = map;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, "\t")}\n`);
	return already ? "present" : "written";
}

export type ClientResult = { label: string; path: string; scope: Scope; status: "written" | "present" };

export async function writeClientConfig(id: ClientId, cwd: string, packageDir: string): Promise<ClientResult> {
	const spec = CLIENTS[id];
	const path = spec.file(cwd);
	const serverPath = serverPathFor(spec, cwd, packageDir);
	const status = spec.format === "toml" ? await writeToml(path, serverPath) : await writeJson(spec, path, serverPath);
	const shown = spec.scope === "global" ? path.replace(homedir(), "~") : relative(cwd, path);
	return { label: spec.label, path: shown, scope: spec.scope, status };
}

export function clientList(): string {
	return (Object.keys(CLIENTS) as ClientId[]).join(", ");
}
