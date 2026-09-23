import type { Frame, UINode } from "../../src/protocol.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	CROP_MARGIN_POINTS,
	DEFAULT_SCREENSHOT_SCALE,
	DEFAULT_WAIT_MS,
	POLL_INTERVAL_MS,
	STATUS_WAIT_MS,
} from "../constants.js";
import { android, hasAdb } from "../android.js";
import { deviceFor } from "../devices.js";
import { ios } from "../ios.js";
import {
	coordinateHint,
	describeLine,
	describeRoute,
	diffTrees,
	filterTree,
	formatDiff,
	json,
	outline,
} from "../format.js";
import { type ToolContext, locate, platformSchema, shortenStack, targetSchema, text } from "./shared.js";

function grow(frame: Frame, margin: number): Frame {
	return {
		x: frame.x - margin,
		y: frame.y - margin,
		width: frame.width + margin * 2,
		height: frame.height + margin * 2,
	};
}

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
					...(app.listenFailure && { serverError: app.listenFailure }),
				}),
			);
		},
	);

	server.registerTool(
		"screenshot",
		{
			description: `PNG of the screen at ${DEFAULT_SCREENSHOT_SCALE}× point size by default: a quarter of the tokens, enough for layout (text is what tree is for). target crops to one element at full detail; scale:1 makes text legible. The reply says how to convert coordinates.`,
			inputSchema: {
				target: targetSchema
					.optional()
					.describe(`Crop to this element with ${CROP_MARGIN_POINTS}pt of context, at full detail.`),
				scale: z
					.number()
					.positive()
					.max(1)
					.optional()
					.describe(
						`Fraction of point size (default ${DEFAULT_SCREENSHOT_SCALE}; 1 = 1px per point). Crops default to 1.`,
					),
				width: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Output width in pixels; overrides scale, never upscales."),
				platform: platformSchema,
			},
		},
		async ({ target, scale, width, platform }) => {
			const pointWidth = app.connectionFor(platform)?.device.windowWidth ?? null;
			const node = target === undefined ? null : await locate(app, target, undefined, platform);
			if (node && !node.frame) throw new Error(`Element has no on-screen frame: ${describeLine(node)}`);
			const crop = node?.frame ? grow(node.frame, CROP_MARGIN_POINTS) : null;

			const device = await deviceFor(app, platform);
			const shot = await device.screenshot({ preferredPixelWidth: width, pointWidth, scale, crop });
			const data = (await readFile(shot.path)).toString("base64");
			const shows = shot.cropped && node ? `Cropped to ${describeLine(node, false)}` : "Full screen";

			return {
				content: [
					{ type: "image", data, mimeType: "image/png" },
					{ type: "text", text: `${shows}, ${shot.width}px wide; ${coordinateHint(shot)}` },
				],
			};
		},
	);

	server.registerTool(
		"tree",
		{
			description:
				"What the app renders: every element with text, label, testID, onPress, input or scroll view. Use instead of screenshots. Coordinates only with frames:true.",
			inputSchema: {
				format: z.enum(["outline", "json"]).optional().describe("outline (default) or json"),
				interactive: z.boolean().optional().describe("Only pressable/input/scroll nodes and their ancestors"),
				maxDepth: z.number().int().min(1).optional().describe("Levels to return (1 = top level)"),
				frames: z.boolean().optional().describe("Include coordinates"),
				includeOffscreen: z.boolean().optional().describe("Include mounted but off-screen elements"),
				changesSince: z
					.boolean()
					.optional()
					.describe("Only what changed since the last tree call; use after an action"),
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
			description: "The focused route and its path; full:true for the whole navigation state.",
			inputSchema: { full: z.boolean().optional().describe("Whole nested navigation state"), platform: platformSchema },
		},
		async ({ full, platform }) => {
			const state = await app.request("navState", {}, platform);
			return text(full ? json(state) : describeRoute(state));
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
