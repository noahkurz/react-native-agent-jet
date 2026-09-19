#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { WebSocketServer } from "ws";
import type { Hello } from "../src/protocol.js";
import { DEFAULT_PORT } from "../src/constants.js";
import { ENV, PACKAGE_NAME, PLAYBOOK_FILE, SERVER_KEY, SKILL_PATH } from "./constants.js";
import { addCommand, PLAYBOOK, PLAYBOOK_MARKER, SETUP_PROMPT, SKILL, type PackageManager } from "./playbook.js";
import { android, hasAdb } from "./android.js";
import { CLIENTS, clientList, resolveClient, tomlTablePattern, writeClientConfig, type ClientId } from "./clients.js";
import { bootedName, hasAxe } from "./ios.js";

const ok = (message: string) => console.log(`  ✓ ${message}`);
const warn = (message: string) => console.log(`  ! ${message}`);

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;

		const isFlag = arg.startsWith("--");
		if (!isFlag) continue;

		const next = rest[i + 1];
		const nextIsThisFlagsValue = next !== undefined && !next.startsWith("--");
		if (nextIsThisFlagsValue) {
			flags.set(arg.slice(2), next);
			i++;
		} else {
			flags.set(arg.slice(2), true);
		}
	}
	return { command, flags };
}

function installedPackageDir(cwd: string): string | null {
	const local = join(cwd, "node_modules", PACKAGE_NAME);
	const isInstalledLocally = existsSync(join(local, "package.json"));
	if (isInstalledLocally) return local;
	try {
		const require = createRequire(join(cwd, "package.json"));
		return dirname(require.resolve(`${PACKAGE_NAME}/package.json`));
	} catch {
		return null;
	}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${path} is not valid JSON; fix or remove it and rerun`);
	}
}

function rootFileHint(cwd: string): string {
	const candidates = ["app/_layout.tsx", "App.tsx", "app/_layout.js", "App.js", "src/App.tsx", "index.js"];
	return candidates.find((candidate) => existsSync(join(cwd, candidate))) ?? "your root component file";
}

function detectPackageManager(cwd: string): PackageManager {
	const hasLockfile = (name: string) => existsSync(join(cwd, name));
	if (hasLockfile("bun.lock") || hasLockfile("bun.lockb")) return "bun";
	if (hasLockfile("pnpm-lock.yaml")) return "pnpm";
	if (hasLockfile("yarn.lock")) return "yarn";
	return "npm";
}

async function writeSkill(cwd: string): Promise<"written" | "present"> {
	const path = join(cwd, ...SKILL_PATH);
	const skillAlreadyWritten = existsSync(path);
	if (skillAlreadyWritten) return "present";

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, SKILL);
	return "written";
}

async function appendPlaybook(cwd: string): Promise<"appended" | "present" | "missing"> {
	const path = join(cwd, PLAYBOOK_FILE);
	const projectHasAPlaybook = existsSync(path);
	if (!projectHasAPlaybook) return "missing";

	const current = await readFile(path, "utf8");
	const playbookAlreadyAppended = current.includes(PLAYBOOK_MARKER);
	if (playbookAlreadyAppended) return "present";

	await writeFile(path, `${current.trimEnd()}\n\n${PLAYBOOK}`);
	return "appended";
}

async function reportDevices() {
	const simulator = await bootedName().catch(() => null);
	if (simulator) ok(`iOS Simulator booted: ${simulator}`);

	const axeInstalled = await hasAxe();
	if (axeInstalled) ok("AXe installed (real keystrokes, taps and swipes on iOS)");
	else
		warn("AXe not installed; optional, enables real keystrokes and touches on iOS: brew install cameroncooke/axe/axe");

	const adb = await hasAdb();
	const device = adb ? await android.name() : null;
	if (device) ok(`Android device: ${device}`);
	else if (adb) ok("adb installed (real input on Android); no device connected right now");
	else warn("adb not on PATH; optional, needed for Android screenshots and input");

	const nothingIsRunning = !simulator && !device;
	if (nothingIsRunning) warn("no iOS Simulator or Android device is running; start one before testing");
}

function resolveClients(flag: string | true | undefined): ClientId[] | null {
	if (flag === undefined) return ["claude"];
	if (flag === "all") return Object.keys(CLIENTS) as ClientId[];
	if (flag === true) return null;
	const ids: ClientId[] = [];
	for (const name of flag
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		const id = resolveClient(name);
		if (!id) return null;
		ids.push(id);
	}
	return ids.length ? ids : null;
}

async function init(flags: Map<string, string | true>) {
	const cwd = process.cwd();
	const isAProjectRoot = existsSync(join(cwd, "package.json"));
	if (!isAProjectRoot) {
		throw new Error("No package.json here. Run this from your app's root directory.");
	}

	const appName = ((await readJson(join(cwd, "package.json"))).name as string | undefined) ?? "my-app";
	console.log("\nreact-native-agent-jet init\n");

	const packageDir = installedPackageDir(cwd);
	if (!packageDir) {
		throw new Error(
			`react-native-agent-jet is not installed in this project. Run \`${addCommand(detectPackageManager(cwd))}\` first.`,
		);
	}
	ok(`package installed at ${relative(cwd, packageDir) || "."}`);

	const clients = resolveClients(flags.get("client"));
	if (clients === null) {
		throw new Error(`Unknown --client. Choose from: ${clientList()}, or "all".`);
	}

	for (const id of clients) {
		const r = await writeClientConfig(id, cwd, packageDir);
		ok(
			`${r.label}: ${r.status === "written" ? "registered in" : "already in"} ${r.path}${r.scope === "global" ? " (global)" : ""}`,
		);
	}

	await reportDevices();

	if (flags.get("skill") !== "false") {
		const skillPath = SKILL_PATH.join("/");
		const skill = await writeSkill(cwd);
		ok(skill === "written" ? `wrote ${skillPath}` : `${skillPath} already exists`);
	}

	if (flags.get("playbook") === "true") {
		const playbook = await appendPlaybook(cwd);
		if (playbook === "appended") ok(`added the agent playbook to ${PLAYBOOK_FILE}`);
		else if (playbook === "present") ok(`${PLAYBOOK_FILE} already has the agent playbook`);
		else warn(`no ${PLAYBOOK_FILE} found to append the playbook to`);
	}

	console.log(`
Next, call the hook once in ${rootFileHint(cwd)}:

  import { useAgentJet } from "${PACKAGE_NAME}";

  useAgentJet({ navigationRef, queryClient, appName: "${appName}" });

Every option is optional, and no __DEV__ guard is needed. Then restart your agent so it loads the new server, run the app in the simulator/emulator, and ask it to call \`status\`.
`);
}

async function registeredClients(cwd: string): Promise<string[]> {
	const found: string[] = [];
	for (const id of Object.keys(CLIENTS) as ClientId[]) {
		const spec = CLIENTS[id];
		const path = spec.file(cwd);

		const clientHasAConfigHere = existsSync(path);
		if (!clientHasAConfigHere) continue;

		try {
			const text = await readFile(path, "utf8");
			const hit = spec.format === "toml" ? tomlTablePattern().test(text) : text.includes(`"${SERVER_KEY}"`);
			if (hit) found.push(spec.label);
		} catch {}
	}

	return found;
}

async function doctor() {
	const cwd = process.cwd();
	console.log("\nreact-native-agent-jet doctor\n");
	const packageDir = installedPackageDir(cwd);
	if (packageDir) {
		const version = (await readJson(join(packageDir, "package.json"))).version;
		ok(`package ${version} at ${relative(cwd, packageDir) || "."}`);
	} else warn(`package not installed here; run from your app's root, or \`${addCommand(detectPackageManager(cwd))}\``);

	const registered = await registeredClients(cwd);
	if (registered.length) ok(`MCP server registered for ${registered.join(", ")}`);
	else warn("no MCP registration found; run `npx react-native-agent-jet init`");

	await reportDevices();

	const port = Number(process.env[ENV.port] ?? DEFAULT_PORT);
	await new Promise<void>((resolve) => {
		const server = new WebSocketServer({ port });
		const finish = () => {
			for (const client of server.clients) client.terminate();
			server.close();
			resolve();
		};
		server.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE")
				ok(`port ${port} is in use, so an MCP server is already running; ask the agent to call status`);
			else warn(`could not listen on port ${port}: ${error.message}`);
			resolve();
		});
		server.on("listening", () => {
			console.log(`  … waiting up to 6s for the app to connect on ws://localhost:${port}`);
			const timer = setTimeout(() => {
				warn("no app connected; make sure the app is running in the simulator with useAgentJet() in a dev build");
				finish();
			}, 6000);
			server.on("connection", (socket) => {
				socket.once("message", (data) => {
					const hello = JSON.parse(String(data)) as Hello;
					clearTimeout(timer);
					ok(
						`app connected: ${hello.device.appName ?? "unnamed"} on ${hello.device.platform}, bridge ${hello.version}`,
					);
					finish();
				});
			});
		});
	});
	console.log();
}

function help() {
	console.log(`
react-native-agent-jet

  init [--client <name[,name]|all>] [--skill false] [--playbook true]
        Register the MCP server, write the agent-jet skill, check the simulator and AXe.
        Clients: claude, cursor, vscode, codex, windsurf, gemini, zed (default: claude)
  doctor
        Check the installation and whether the app connects
  setup-prompt
        Print a prompt you can paste to a coding agent to do the whole setup for you
  mcp
        Run the MCP server over stdio (what the registration points at)
`);
}

const { command, flags } = parseArgs(process.argv.slice(2));
try {
	if (command === "init") await init(flags);
	else if (command === "doctor") await doctor();
	else if (command === "setup-prompt") console.log(SETUP_PROMPT);
	else if (command === "mcp") await import("./mcp.js");
	else help();
} catch (error) {
	console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
