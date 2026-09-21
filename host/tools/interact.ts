import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UINode } from "../../src/protocol.js";
import { DEFAULT_SWIPE_DISTANCE, DEFAULT_SWIPE_SECONDS, FOCUS_SETTLE_MS } from "../constants.js";
import { deviceFor } from "../devices.js";
import { describeLine, json } from "../format.js";
import { type ToolContext, center, locate, platformSchema, targetSchema, text } from "./shared.js";

export function registerInteractTools(server: McpServer, { app, lastTree }: ToolContext) {
	server.registerTool(
		"press",
		{
			description:
				'Press an element through its onPress (instant). via:"touch" sends a real touch at its centre instead: native gestures, but seconds on iOS.',
			inputSchema: {
				target: targetSchema,
				index: z.number().int().optional(),
				via: z.enum(["js", "touch"]).optional(),
				platform: platformSchema,
			},
		},
		async ({ target, index, via, platform }) => {
			const shouldUseRealTouch = via === "touch";
			if (shouldUseRealTouch) {
				const device = await deviceFor(app, platform);
				const node = await locate(app, target, index, platform);
				const point = center(node);

				if (point) {
					await device.tap(point);
					return text(`Tapped ${describeLine(node)} at (${point.x},${point.y})`);
				}

				const accessible = node.testID ? { id: node.testID } : node.label ? { label: node.label } : null;
				const tapByAccessibility = device.tapAccessible;
				if (!accessible || !tapByAccessibility) {
					throw new Error(`Element has no on-screen frame: ${describeLine(node)}`);
				}

				await tapByAccessibility(accessible);
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
				"Real touch at a point, in points as tree/find report (convert screenshot coordinates per its reply). For native UI the tree cannot see, such as system alerts. Slow on iOS.",
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
				"Type with real keystrokes (ASCII-only on Android). Focuses target first if given; without real input, falls back to set_text and needs a target.",
			inputSchema: {
				text: z.string(),
				target: targetSchema.optional(),
				submit: z.boolean().optional().describe("Press return afterwards"),
				platform: platformSchema,
			},
		},
		async ({ text: value, target, submit, platform }) => {
			const device = await deviceFor(app, platform);
			const canSendRealKeystrokes = await device.hasInput();
			if (!canSendRealKeystrokes) {
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
				await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
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
				"Set an input's value through React, no keystrokes. Faster than type_text but skips keyboard behaviour.",
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
				"Real swipe in the finger's direction from the target's centre, or the screen centre. Prefer scroll_to for scrolling; slow on iOS.",
			inputSchema: {
				direction: z.enum(["up", "down", "left", "right"]),
				target: targetSchema.optional(),
				distance: z.number().optional().describe(`Points to move, default ${DEFAULT_SWIPE_DISTANCE}`),
				durationSeconds: z.number().optional().describe(`Default ${DEFAULT_SWIPE_SECONDS}`),
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
			const amount = distance ?? DEFAULT_SWIPE_DISTANCE;
			const delta = {
				up: { x: 0, y: -amount },
				down: { x: 0, y: amount },
				left: { x: -amount, y: 0 },
				right: { x: amount, y: 0 },
			}[direction];
			const end = { x: start.x + delta.x, y: start.y + delta.y };
			await (await deviceFor(app, platform)).swipe(start, end, durationSeconds ?? DEFAULT_SWIPE_SECONDS);
			return text(`Swiped ${direction} from (${start.x},${start.y}) to (${end.x},${end.y})`);
		},
	);

	server.registerTool(
		"scroll_to",
		{
			description:
				"Scroll a list programmatically, no gesture: toEnd or an x/y offset. Target defaults to the first scroll view.",
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
}
