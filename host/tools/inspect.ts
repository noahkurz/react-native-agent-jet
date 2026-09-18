/** Tools that read the app: what is on screen, where it is, and what it did. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_WAIT_MS, POLL_INTERVAL_MS, STATUS_WAIT_MS } from "../constants.js";
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
					ios: { simulator: await ios.name().catch(() => null), axeInstalled: await ios.hasInput() },
					android: { device: adbInstalled ? await android.name() : null, adbInstalled },
					websocketPort: app.port,
				}),
			);
		},
	);
	server.registerTool(
		"screenshot",
		{
			description:
				"Capture the device screen. When the app is connected the image is scaled so 1 image pixel = 1 point (dp on Android) and coordinates read off it can be passed straight to tap and swipe. The reply says which scale was used.",
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
					{
						type: "text",
						text: shot.inPoints
							? `Saved to ${shot.path} (${shot.width}px wide, 1px = 1pt — safe for tap/swipe coordinates)`
							: `Saved to ${shot.path} (${shot.width}px wide, native resolution — the device scale is unknown, so these are pixels, not points; connect the app or pass width to get point coordinates)`,
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
				timeoutMs: z.number().int().optional().describe(`Default ${DEFAULT_WAIT_MS}`),
				platform: platformSchema,
			},
		},
		async ({ target, timeoutMs, platform }) => {
			const deadline = Date.now() + (timeoutMs ?? DEFAULT_WAIT_MS);
			while (true) {
				const matches = await app.request("find", { target }, platform);
				if (matches.length) return text(matches.map((node) => describeLine(node)).join("\n"));
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(target)}`);
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
