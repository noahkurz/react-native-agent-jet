import type { UINode } from "../../src/protocol.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SCREENSHOT_SCALE, DEFAULT_WAIT_MS, POLL_INTERVAL_MS, STATUS_WAIT_MS } from "../constants.js";
import { android, hasAdb } from "../android.js";
import { deviceFor } from "../devices.js";
import { ios } from "../ios.js";
import { describeLine, diffTrees, filterTree, formatDiff, json, outline } from "../format.js";
import { type ToolContext, platformSchema, shortenStack, targetSchema, text } from "./shared.js";

export function registerInspectTools(server: McpServer, { app, lastTree }: ToolContext) {
	server.registerTool(
		"status",
		{
			description:
				"Report whether the app is connected, which iOS Simulator or Android device is available, and whether real input works (AXe on iOS, adb on Android).",
		},
		async () => {
			const appConnected = await app.ready(STATUS_WAIT_MS);
			const adbInstalled = await hasAdb();

			return text(
				json({
					appConnected,
					app: app.device,
					bridgeVersion: app.version,
					connectedApps: app.all,
					preferredPlatform: app.preferred,
					ios: { simulator: await ios.name(), axeInstalled: await ios.hasInput() },
					android: { device: adbInstalled ? await android.name() : null, adbInstalled },
					websocketPort: app.port,
				}),
			);
		},
	);

	server.registerTool(
		"screenshot",
		{
			description: `Capture the device screen. Defaults to ${DEFAULT_SCREENSHOT_SCALE}× the screen's point size, which costs a quarter of the tokens of a full-size image and still shows layout, spacing and colour — the text on screen is what 'tree' is for. Pass scale:1 when you need to read rendered text, such as an error overlay. The reply says how to convert coordinates read off the image.`,
			inputSchema: {
				scale: z
					.number()
					.positive()
					.max(1)
					.optional()
					.describe(
						`Fraction of the screen's point size (default ${DEFAULT_SCREENSHOT_SCALE}). 1 means 1 image pixel = 1 point, so coordinates can be passed straight to tap and swipe.`,
					),
				width: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(
						"Absolute output width in pixels. Overrides scale, is never upscaled, and is the only size control when no app is connected.",
					),
				platform: platformSchema,
			},
		},
		async ({ scale, width, platform }) => {
			const pointWidth = app.connectionFor(platform)?.device.windowWidth ?? null;
			const shot = await (
				await deviceFor(app, platform)
			).screenshot({
				preferredPixelWidth: width,
				pointWidth,
				scale,
			});
			const data = (await readFile(shot.path)).toString("base64");

			const pointsPerPixel = pointWidth === null ? null : pointWidth / shot.width;
			const howToConvert =
				pointsPerPixel === null
					? "no app is connected, so the point size of this screen is unknown and coordinates cannot be converted"
					: `multiply coordinates read off it by ${Number(pointsPerPixel.toFixed(2))} to get points for tap/swipe`;

			return {
				content: [
					{ type: "image", data, mimeType: "image/png" },
					{
						type: "text",
						text: shot.inPoints
							? `Saved to ${shot.path} (${shot.width}px wide, 1px = 1pt — safe for tap/swipe coordinates)`
							: `Saved to ${shot.path} (${shot.width}px wide — ${howToConvert})`,
					},
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
				maxDepth: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Maximum number of levels to return (1 = top-level nodes only)"),
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

			const wasFiltered = interactive || maxDepth !== undefined;
			const filter = (tree: UINode[]) => (wasFiltered ? filterTree(tree, { interactive, maxDepth }) : tree);

			if (changesSince) {
				const previous = lastTree.get(key) ?? null;
				const diff = diffTrees(previous && filter(previous), filter(raw));
				lastTree.set(key, raw);
				return text(formatDiff(diff));
			}

			lastTree.set(key, raw);
			const nodes = filter(raw);
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
				timeoutMs: z.number().int().optional().describe(`Default ${DEFAULT_WAIT_MS}`),
				platform: platformSchema,
			},
		},
		async ({ target, timeoutMs, platform }) => {
			const deadline = Date.now() + (timeoutMs ?? DEFAULT_WAIT_MS);
			while (true) {
				const matches = await app.request("find", { target }, platform);
				if (matches.length) return text(matches.map((node) => describeLine(node)).join("\n"));
				const deadlineHasPassed = Date.now() > deadline;
				if (deadlineHasPassed) throw new Error(`Timed out waiting for ${JSON.stringify(target)}`);
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}
		},
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
}
