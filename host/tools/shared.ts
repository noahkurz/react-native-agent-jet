import { z } from "zod";
import type { Target, UINode } from "../../src/protocol.js";
import type { Platform } from "../device.js";
import type { AppConnection } from "../app.js";

export type ToolResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
};

const BUNDLE_URL = /https?:\/\/[^\s)]*?index\.bundle[^\s:)]*/g;

export function shortenStack(stack: string): string {
	return stack.replace(BUNDLE_URL, "bundle");
}

export function text(value: string): ToolResult {
	return { content: [{ type: "text", text: value }] };
}

export const selectorSchema = z.object({
	testID: z.string().optional(),
	text: z.string().optional(),
	label: z.string().optional(),
	type: z.string().optional(),
	exact: z.boolean().optional(),
	index: z.number().int().optional(),
});

export const targetSchema = z
	.union([z.string(), selectorSchema])
	.describe(
		'Element to act on. A string matches testID exactly, or text/label/placeholder/value by case-insensitive substring, or "#id" from the tree. An object narrows by field; index picks among multiple matches.',
	);

export const platformSchema = z
	.enum(["ios", "android"])
	.optional()
	.describe("Which connected app to target when both iOS and Android are running. Defaults to the active one.");

export function center(node: UINode): { x: number; y: number } | null {
	if (!node.frame || node.visible === false) return null;
	return { x: Math.round(node.frame.x + node.frame.width / 2), y: Math.round(node.frame.y + node.frame.height / 2) };
}

export async function locate(
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

/** Everything a tool group needs: the app connection plus state shared across calls. */
export type ToolContext = {
	app: AppConnection;
	/** Last full tree per platform, so `tree changesSince:true` can diff against it. */
	lastTree: Map<string, UINode[]>;
};
