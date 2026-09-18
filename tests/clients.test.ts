import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { CLIENTS, resolveClient, writeClientConfig } from "../host/clients.js";

/** A throwaway project with the package "installed", so paths resolve like a real one. */
function project() {
	const cwd = mkdtempSync(join(tmpdir(), "jet-proj-"));
	const pkgDir = join(cwd, "node_modules", "react-native-agent-jet");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(cwd, "package.json"), '{"name":"demo"}');
	return { cwd, pkgDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const read = (p: string) => readFileSync(p, "utf8");

describe("resolveClient", () => {
	test("accepts every advertised client, case-insensitively", () => {
		for (const id of Object.keys(CLIENTS)) expect(resolveClient(id.toUpperCase())).toBe(id as never);
	});

	test("rejects anything else rather than guessing", () => {
		expect(resolveClient("emacs")).toBeNull();
	});
});

describe("project-scoped json clients", () => {
	test("writes the server with a relative path", async () => {
		const { cwd, pkgDir, cleanup } = project();
		const result = await writeClientConfig("claude", cwd, pkgDir);
		const config = JSON.parse(read(join(cwd, ".mcp.json")));
		expect(result.status).toBe("written");
		expect(config.mcpServers.jet.command).toBe("node");
		expect(config.mcpServers.jet.args[0]).toBe("node_modules/react-native-agent-jet/dist/host/mcp.js");
		cleanup();
	});

	test("preserves other servers already in the file", async () => {
		const { cwd, pkgDir, cleanup } = project();
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "foo" } } }));
		await writeClientConfig("claude", cwd, pkgDir);
		const config = JSON.parse(read(join(cwd, ".mcp.json")));
		expect(Object.keys(config.mcpServers).sort()).toEqual(["jet", "other"]);
		cleanup();
	});

	test("re-running reports the server is already registered", async () => {
		const { cwd, pkgDir, cleanup } = project();
		await writeClientConfig("claude", cwd, pkgDir);
		expect((await writeClientConfig("claude", cwd, pkgDir)).status).toBe("present");
		cleanup();
	});

	test("vscode uses its own schema key and stdio type", async () => {
		const { cwd, pkgDir, cleanup } = project();
		await writeClientConfig("vscode", cwd, pkgDir);
		const config = JSON.parse(read(join(cwd, ".vscode", "mcp.json")));
		expect(config.servers.jet.type).toBe("stdio");
		cleanup();
	});

	test("zed uses context_servers", async () => {
		const { cwd, pkgDir, cleanup } = project();
		await writeClientConfig("zed", cwd, pkgDir);
		expect(JSON.parse(read(join(cwd, ".zed", "settings.json"))).context_servers.jet.source).toBe("custom");
		cleanup();
	});

	test("refuses to clobber a config that is not valid json", async () => {
		const { cwd, pkgDir, cleanup } = project();
		writeFileSync(join(cwd, ".mcp.json"), "{ not json");
		await expect(writeClientConfig("claude", cwd, pkgDir)).rejects.toThrow(/not valid JSON/);
		cleanup();
	});
});

describe("global-scoped clients", () => {
	test("codex appends a toml table with an absolute path, and is idempotent", async () => {
		const { cwd, pkgDir, cleanup } = project();
		const home = mkdtempSync(join(tmpdir(), "jet-home-"));
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			// CLIENTS.codex.file() reads homedir() which honours $HOME on posix
			const path = CLIENTS.codex.file(cwd);
			if (path.startsWith(home)) {
				const first = await writeClientConfig("codex", cwd, pkgDir);
				expect(first.status).toBe("written");
				expect(read(path)).toContain("[mcp_servers.jet]");
				expect(read(path)).toContain(pkgDir); // absolute, since the config lives outside the project
				expect((await writeClientConfig("codex", cwd, pkgDir)).status).toBe("present");
			}
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(home, { recursive: true, force: true });
			cleanup();
		}
	});

	test("global clients are reported as global", () => {
		expect(CLIENTS.codex.scope).toBe("global");
		expect(CLIENTS.windsurf.scope).toBe("global");
		expect(CLIENTS.claude.scope).toBe("project");
	});
});
