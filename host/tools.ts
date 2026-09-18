import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Target, UINode } from "../src/protocol.js";
import type { Platform } from "./device.js";
import type { AppConnection } from "./app.js";
import { describeLine, diffTrees, filterTree, formatDiff, json, outline } from "./format.js";
import { android, hasAdb } from "./android.js";
import { deviceFor } from "./devices.js";
import { ios } from "./ios.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
};

const BUNDLE_URL = /https?:\/\/[^\s)]*?index\.bundle[^\s:)]*/g;

function shortenStack(stack: string): string {
	return stack.replace(BUNDLE_URL, "bundle");
}

function text(value: string): ToolResult {
	return { content: [{ type: "text", text: value }] };
}

const selectorSchema = z.object({
	testID: z.string().optional(),
	text: z.string().optional(),
	label: z.string().optional(),
	type: z.string().optional(),
	exact: z.boolean().optional(),
	index: z.number().int().optional(),
});

const targetSchema = z
	.union([z.string(), selectorSchema])
	.describe(
		'Element to act on. A string matches testID exactly, or text/label/placeholder/value by case-insensitive substring, or "#id" from the tree. An object narrows by field; index picks among multiple matches.',
	);

const platformSchema = z
	.enum(["ios", "android"])
	.optional()
	.describe("Which connected app to target when both iOS and Android are running. Defaults to the active one.");

function center(node: UINode): { x: number; y: number } | null {
	if (!node.frame || node.visible === false) return null;
	return { x: Math.round(node.frame.x + node.frame.width / 2), y: Math.round(node.frame.y + node.frame.height / 2) };
}

async function locate(
	app: AppConnection,
	target: Target,
	index: number | undefined,
	platform?: Platform,
): Promise<UINode> {
	const matches = await app.request("find", { target }, platform);
	const picked = matches[index ?? (typeof target === "string" ? 0 : (target.index ?? 0))];
	if (!picked) {
		throw new Error(
			matches.length === 0
				? `No visible element matches ${JSON.stringify(target)}. Call tree to see what is on screen.`
				: `Index out of range: ${matches.length} elements match ${JSON.stringify(target)}`,
		);
	}
	return picked;
}

export function registerTools(server: McpServer, app: AppConnection) {
	const lastTree = new Map<string, UINode[]>();
	server.registerTool(
		"status",
		{
			description:
				"Report whether the app is connected, which iOS Simulator or Android device is available, and whether real input works (AXe on iOS, adb on Android).",
		},
		async () => {
			const appConnected = await app.ready(3000);
			const adbInstalled = await hasAdb();
			return text(
				json({
					appConnected,
					app: app.device,
					bridgeVersion: app.version,
					connectedApps: app.all,
					preferredPlatform: app.preferred,
					ios: { simulator: await ios.name().catch(() => null), axeInstalled: await ios.hasInput() },
					android: { device: adbInstalled ? await android.name() : null, adbInstalled },
					websocketPort: app.port,
				}),
			);
		},
	);

	server.registerTool(
		"select_platform",
		{
			description:
				"Set the DEFAULT platform to drive when both iOS and Android are connected. Optional — every tool also takes a per-call `platform`, so you can drive both without switching. Defaults to the most recently connected app.",
			inputSchema: { platform: z.enum(["ios", "android"]) },
		},
		async ({ platform }) => {
			app.preferred = platform;
			return text(
				`Driving ${platform}${app.connected ? ` (${app.device?.appName ?? "app"} connected)` : " (no app connected yet)"}`,
			);
		},
	);

	server.registerTool(
		"screenshot",
		{
			description:
				"Capture the device screen. The image is scaled so that 1 image pixel = 1 point (dp on Android), so coordinates you read off it can be passed straight to tap and swipe.",
			inputSchema: {
				width: z.number().int().optional().describe("Override the output width in pixels"),
				platform: platformSchema,
			},
		},
		async ({ width, platform }) => {
			const targetWidth = width ?? app.connectionFor(platform)?.device.windowWidth ?? null;
			const shot = await (await deviceFor(app, platform)).screenshot(targetWidth);
			const data = (await readFile(shot.path)).toString("base64");
			return {
				content: [
					{ type: "image", data, mimeType: "image/png" },
					{ type: "text", text: `Saved to ${shot.path} (${shot.width}px wide, 1px = 1pt)` },
				],
			};
		},
	);

	server.registerTool(
		"tree",
		{
			description:
				"Semantic tree of what the app currently renders, built from React's component tree: every element with a testID, label, text, onPress, text input or scroll view. Use this instead of screenshots to see and act on the screen. Coordinates are omitted by default (press/type/find work by selector); pass frames:true only when you need to tap a point.",
			inputSchema: {
				format: z.enum(["outline", "json"]).optional().describe("outline (default, compact) or json"),
				interactive: z
					.boolean()
					.optional()
					.describe("Only actionable nodes (pressable, input, scroll) and their ancestors — much smaller"),
				maxDepth: z.number().int().optional().describe("Cap nesting depth"),
				frames: z.boolean().optional().describe("Include on-screen coordinates (default false)"),
				includeOffscreen: z.boolean().optional().describe("Include elements that are mounted but off screen"),
				changesSince: z
					.boolean()
					.optional()
					.describe("Return only what changed since the previous tree call for this app — ideal after an action"),
				platform: platformSchema,
			},
		},
		async ({ format, interactive, maxDepth, frames, includeOffscreen, changesSince, platform }) => {
			const raw = await app.request(
				"tree",
				{ layout: frames || !includeOffscreen, visibleOnly: !includeOffscreen },
				platform,
			);
			const key = platform ?? app.connectionFor()?.device.platform ?? "default";
			if (changesSince) {
				const diff = diffTrees(lastTree.get(key) ?? null, raw);
				lastTree.set(key, raw);
				return text(formatDiff(diff));
			}
			lastTree.set(key, raw);
			const nodes = interactive || maxDepth !== undefined ? filterTree(raw, { interactive, maxDepth }) : raw;
			if (format === "json") return text(json(nodes));
			const lines = outline(nodes, frames ?? false);
			return text(lines.length ? lines.join("\n") : "(nothing rendered)");
		},
	);

	server.registerTool(
		"find",
		{
			description: "List visible elements matching a target, with frames.",
			inputSchema: { target: targetSchema, platform: platformSchema },
		},
		async ({ target, platform }) => {
			const matches = await app.request("find", { target }, platform);
			return text(
				matches.length
					? matches.map((node) => describeLine(node)).join("\n")
					: `No visible element matches ${JSON.stringify(target)}`,
			);
		},
	);

	server.registerTool(
		"wait_for",
		{
			description: "Poll until an element matching the target is visible, or fail after the timeout.",
			inputSchema: {
				target: targetSchema,
				timeoutMs: z.number().int().optional().describe("Default 5000"),
				platform: platformSchema,
			},
		},
		async ({ target, timeoutMs, platform }) => {
			const deadline = Date.now() + (timeoutMs ?? 5000);
			while (true) {
				const matches = await app.request("find", { target }, platform);
				if (matches.length) return text(matches.map((node) => describeLine(node)).join("\n"));
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(target)}`);
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		},
	);

	server.registerTool(
		"press",
		{
			description:
				'Press an element. By default invokes its onPress through React, which is instant. Pass via: "touch" for a real touch at the element\'s center (exercises native gesture handling, but fast through adb on Android, several seconds through AXe on iOS because it serializes the accessibility tree first).',
			inputSchema: {
				target: targetSchema,
				index: z.number().int().optional(),
				via: z.enum(["js", "touch"]).optional(),
				platform: platformSchema,
			},
		},
		async ({ target, index, via, platform }) => {
			if (via === "touch") {
				const device = await deviceFor(app, platform);
				const node = await locate(app, target, index, platform);
				const point = center(node);
				if (point) {
					await device.tap(point);
					return text(`Tapped ${describeLine(node)} at (${point.x},${point.y})`);
				}
				const accessible = node.testID ? { id: node.testID } : node.label ? { label: node.label } : null;
				if (!accessible || !device.tapAccessible)
					throw new Error(`Element has no on-screen frame: ${describeLine(node)}`);
				await device.tapAccessible(accessible);
				return text(`Tapped ${describeLine(node)} by accessibility ${JSON.stringify(accessible)}`);
			}
			const pressed = await app.request("press", { target, index }, platform);
			return text(`Pressed ${describeLine(pressed)}`);
		},
	);

	server.registerTool(
		"tap",
		{
			description:
				"Real touch at a point (in points, matching screenshot pixels). Useful for native UI the React tree cannot see, such as system alerts. Slow on iOS because AXe serializes the accessibility tree first.",
			inputSchema: { x: z.number(), y: z.number(), platform: platformSchema },
		},
		async ({ x, y, platform }) => {
			await (await deviceFor(app, platform)).tap({ x, y });
			return text(`Tapped (${x},${y})`);
		},
	);

	server.registerTool(
		"type_text",
		{
			description:
				"Type text with real keystrokes (AXe on iOS, adb on Android; adb is ASCII-only). If target is given, that input is focused first through React. Without real input available, falls back to set_text and requires a target.",
			inputSchema: {
				text: z.string(),
				target: targetSchema.optional(),
				submit: z.boolean().optional().describe("Press return afterwards"),
				platform: platformSchema,
			},
		},
		async ({ text: value, target, submit, platform }) => {
			const device = await deviceFor(app, platform);
			if (!(await device.hasInput())) {
				if (!target) {
					throw new Error(
						`Real input is unavailable (${device.inputHint}); provide a target so text can be set through the JS bridge`,
					);
				}
				const node = await app.request("setText", { target, text: value }, platform);
				return text(`Set text on ${describeLine(node)} via ${node.via.join("+")}`);
			}
			let focused: UINode | null = null;
			if (target) {
				focused = await app.request("focus", { target }, platform);
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
			await device.typeText(value);
			if (submit) await device.pressKey("return");
			return text(
				`Typed ${JSON.stringify(value)}${focused ? ` into ${describeLine(focused)}` : ""}${submit ? " and pressed return" : ""}`,
			);
		},
	);

	server.registerTool(
		"set_text",
		{
			description:
				"Set a text input's value directly through React (onChangeText + native props) without keystrokes. Faster than type_text but skips keyboard behaviour.",
			inputSchema: {
				target: targetSchema,
				text: z.string(),
				index: z.number().int().optional(),
				platform: platformSchema,
			},
		},
		async ({ target, text: value, index, platform }) => {
			const node = await app.request("setText", { target, text: value, index }, platform);
			return text(`Set text on ${describeLine(node)} via ${node.via.join("+")}`);
		},
	);

	server.registerTool(
		"swipe",
		{
			description:
				"Real swipe gesture (prefer scroll_to for plain scrolling; slow on iOS). Direction is the finger's movement: swipe up scrolls content down. Starts at the target's center, or the screen center.",
			inputSchema: {
				direction: z.enum(["up", "down", "left", "right"]),
				target: targetSchema.optional(),
				distance: z.number().optional().describe("Points to move, default 300"),
				durationSeconds: z.number().optional().describe("Default 0.3"),
				platform: platformSchema,
			},
		},
		async ({ direction, target, distance, durationSeconds, platform }) => {
			const device = app.connectionFor(platform)?.device;
			let start = device
				? { x: Math.round(device.windowWidth / 2), y: Math.round(device.windowHeight / 2) }
				: { x: 200, y: 400 };
			if (target) {
				const point = center(await locate(app, target, undefined, platform));
				if (!point) throw new Error("Target has no on-screen frame to swipe from");
				start = point;
			}
			const amount = distance ?? 300;
			const delta = {
				up: { x: 0, y: -amount },
				down: { x: 0, y: amount },
				left: { x: -amount, y: 0 },
				right: { x: amount, y: 0 },
			}[direction];
			const end = { x: start.x + delta.x, y: start.y + delta.y };
			await (await deviceFor(app, platform)).swipe(start, end, durationSeconds ?? 0.3);
			return text(`Swiped ${direction} from (${start.x},${start.y}) to (${end.x},${end.y})`);
		},
	);

	server.registerTool(
		"scroll_to",
		{
			description:
				"Scroll a ScrollView/FlatList/FlashList programmatically (no gesture). Target defaults to the first scroll view; pass toEnd or an x/y offset.",
			inputSchema: {
				target: targetSchema.optional(),
				index: z.number().int().optional(),
				x: z.number().optional(),
				y: z.number().optional(),
				toEnd: z.boolean().optional(),
				platform: platformSchema,
			},
		},
		async ({ platform, ...params }) => {
			const node = await app.request("scroll", params, platform);
			return text(`Scrolled ${describeLine(node)}`);
		},
	);

	server.registerTool(
		"press_key",
		{
			description: "Press a keyboard key: return, backspace, tab, space, escape, or a platform keycode number.",
			inputSchema: { key: z.union([z.string(), z.number().int()]), platform: platformSchema },
		},
		async ({ key, platform }) => {
			await (await deviceFor(app, platform)).pressKey(key);
			return text(`Pressed ${key}`);
		},
	);

	server.registerTool(
		"press_button",
		{
			description:
				"Press a hardware button. iOS: home, lock, side-button, siri, apple-pay. Android: home, back, lock, recents.",
			inputSchema: {
				button: z.enum(["home", "back", "lock", "side-button", "recents", "siri", "apple-pay"]),
				platform: platformSchema,
			},
		},
		async ({ button, platform }) => {
			await (await deviceFor(app, platform)).pressButton(button);
			return text(`Pressed ${button}`);
		},
	);

	server.registerTool(
		"navigate",
		{
			description: "Navigate with React Navigation to a route by name, with optional params.",
			inputSchema: { name: z.string(), params: z.record(z.unknown()).optional(), platform: platformSchema },
		},
		async ({ name, params, platform }) => text(json(await app.request("navigate", { name, params }, platform))),
	);

	server.registerTool(
		"go_back",
		{ description: "Go back in the navigation stack.", inputSchema: { platform: platformSchema } },
		async ({ platform }) => text(json(await app.request("goBack", {}, platform))),
	);

	server.registerTool(
		"nav_state",
		{
			description: "The focused route and its path. Pass full:true for the entire navigation state tree.",
			inputSchema: {
				full: z.boolean().optional().describe("Include the full nested navigation state (default false)"),
				platform: platformSchema,
			},
		},
		async ({ full, platform }) => {
			const state = (await app.request("navState", {}, platform)) as {
				current?: unknown;
				path?: unknown;
				state?: unknown;
			};
			if (full) return text(json(state));
			return text(json({ current: state.current, path: state.path }));
		},
	);

	server.registerTool(
		"state",
		{
			description:
				"Read app state exposed through startAgentJet({ state, queryClient }): all keys, or one key. 'queries' summarises the TanStack Query cache.",
			inputSchema: { key: z.string().optional(), platform: platformSchema },
		},
		async ({ key, platform }) => text(json(await app.request("state", { key }, platform))),
	);

	server.registerTool(
		"logs",
		{
			description:
				"Console output and uncaught errors captured in the app, oldest first. Pass since (the last seq you saw) to get only new entries.",
			inputSchema: {
				since: z.number().int().optional(),
				level: z.enum(["log", "info", "warn", "error", "debug", "uncaught"]).optional(),
				platform: platformSchema,
			},
		},
		async ({ since, level, platform }) => {
			const entries = await app.request("logs", { since, level }, platform);
			if (!entries.length) return text("(no log entries)");
			return text(
				entries
					.map(
						(entry) =>
							`${entry.seq} ${new Date(entry.at).toISOString().slice(11, 23)} ${entry.level.toUpperCase()} ${entry.message}${entry.stack ? `\n${shortenStack(entry.stack)}` : ""}`,
					)
					.join("\n"),
			);
		},
	);

	server.registerTool(
		"network",
		{
			description: "HTTP requests made by the app (XHR and fetch), with status, timing and truncated bodies.",
			inputSchema: {
				since: z.number().int().optional(),
				urlContains: z.string().optional(),
				bodies: z.boolean().optional().describe("Include request/response bodies"),
				platform: platformSchema,
			},
		},
		async ({ since, urlContains, bodies, platform }) => {
			const entries = (await app.request("network", { since }, platform)).filter(
				(entry) => !urlContains || entry.url.includes(urlContains),
			);
			if (!entries.length) return text("(no network entries)");
			return text(
				entries
					.map((entry) => {
						const outcome = entry.status ?? (entry.error ? "failed" : "pending");
						const head = `${entry.seq} ${entry.method} ${entry.url} → ${outcome}${entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : ""}${entry.error ? ` (${entry.error})` : ""}`;
						if (!bodies) return head;
						return [
							head,
							entry.requestBody ? `  request: ${entry.requestBody}` : null,
							entry.responseBody ? `  response: ${entry.responseBody}` : null,
						]
							.filter(Boolean)
							.join("\n");
					})
					.join("\n"),
			);
		},
	);

	server.registerTool(
		"clear_logs",
		{ description: "Clear captured logs and network entries.", inputSchema: { platform: platformSchema } },
		async ({ platform }) => {
			await app.request("clear", {}, platform);
			return text("Cleared");
		},
	);

	server.registerTool(
		"open_url",
		{
			description: "Open a URL or deep link on the device (e.g. your app scheme).",
			inputSchema: { url: z.string(), platform: platformSchema },
		},
		async ({ url, platform }) => {
			await (await deviceFor(app, platform)).openUrl(url);
			return text(`Opened ${url}`);
		},
	);

	server.registerTool(
		"reload",
		{ description: "Reload the JS bundle (like pressing r in Metro).", inputSchema: { platform: platformSchema } },
		async ({ platform }) => {
			await app.request("reload", {}, platform);
			return text("Reloading");
		},
	);

	server.registerTool(
		"launch_app",
		{
			description: "Launch an app by bundle identifier (iOS) or package name (Android).",
			inputSchema: { bundleId: z.string(), platform: platformSchema },
		},
		async ({ bundleId, platform }) => {
			await (await deviceFor(app, platform)).launchApp(bundleId);
			return text(`Launched ${bundleId}`);
		},
	);

	server.registerTool(
		"terminate_app",
		{
			description: "Terminate an app by bundle identifier (iOS) or package name (Android).",
			inputSchema: { bundleId: z.string(), platform: platformSchema },
		},
		async ({ bundleId, platform }) => {
			await (await deviceFor(app, platform)).terminateApp(bundleId);
			return text(`Terminated ${bundleId}`);
		},
	);

	server.registerTool(
		"set_appearance",
		{
			description: "Switch the device between light and dark mode.",
			inputSchema: { mode: z.enum(["light", "dark"]), platform: platformSchema },
		},
		async ({ mode, platform }) => {
			await (await deviceFor(app, platform)).setAppearance(mode);
			return text(`Appearance set to ${mode}`);
		},
	);

	server.registerTool(
		"native_tree",
		{
			description:
				"The native accessibility tree (AXe on iOS, uiautomator on Android). Fallback when the app is not connected; less informative than tree.",
			inputSchema: { platform: platformSchema },
		},
		async ({ platform }) => text(await (await deviceFor(app, platform)).describeNativeUi()),
	);
}
