import type { NavigationSummary, UINode } from "../src/protocol.js";
import type { Screenshot } from "./image.js";

const TEXT_LIMIT = 80;

function quote(value: string): string {
	const trimmed = value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
	return JSON.stringify(trimmed);
}

export function describeLine(node: UINode, frames = true): string {
	const parts = [`#${node.id}`, node.type];
	if (node.testID) parts.push(`testID=${quote(node.testID)}`);
	if (node.label) parts.push(`label=${quote(node.label)}`);
	const roleSaysMoreThanPress = node.role && !(node.role === "button" && node.pressable);
	if (roleSaysMoreThanPress) parts.push(`role=${node.role}`);
	if (node.text) parts.push(quote(node.text));

	if (node.input) {
		parts.push("[input]");
		if (node.value !== undefined) parts.push(`value=${quote(node.value)}`);
		if (node.placeholder) parts.push(`placeholder=${quote(node.placeholder)}`);
	}

	if (node.pressable) parts.push("[press]");
	if (node.scrollable) parts.push("[scroll]");

	const frameToReport = frames ? node.frame : undefined;
	if (frameToReport) {
		const { x, y, width, height } = frameToReport;
		parts.push(`@(${x},${y} ${width}x${height})`);
	}
	if (node.visible === false) parts.push("[offscreen]");

	return parts.join(" ");
}

export function outline(nodes: UINode[], frames = false, depth = 0): string[] {
	return nodes.flatMap((node) => [
		`${"  ".repeat(depth)}${describeLine(node, frames)}`,
		...outline(node.children, frames, depth + 1),
	]);
}

function isActionable(node: UINode): boolean {
	return node.pressable === true || node.input === true || node.scrollable === true;
}

function withoutConsecutiveRepeats(items: string[]): string[] {
	return items.filter((item, index) => item !== items[index - 1]);
}

/** The text interactive mode would drop from under a pressable, so a list row still says what it is. */
function droppedText(node: UINode): string {
	const fragments = node.children
		.filter((child) => !isActionable(child))
		.flatMap((child) => [child.text ?? "", droppedText(child)])
		.filter(Boolean);
	return withoutConsecutiveRepeats(fragments).join(" ");
}

export function filterTree(nodes: UINode[], opts: { interactive?: boolean; maxDepth?: number }, depth = 0): UINode[] {
	const askedForNoLevelsAtAll = opts.maxDepth !== undefined && opts.maxDepth < 1;
	if (askedForNoLevelsAtAll) return [];

	const result: UINode[] = [];
	for (const node of nodes) {
		const atDepthLimit = opts.maxDepth !== undefined && depth + 1 >= opts.maxDepth;
		const children = atDepthLimit ? [] : filterTree(node.children, opts, depth + 1);
		const nothingHereToActOn = Boolean(opts.interactive) && !isActionable(node) && children.length === 0;
		if (nothingHereToActOn) continue;

		const needsASummary = Boolean(opts.interactive) && node.pressable === true && !node.text && !node.label;
		const text = needsASummary ? droppedText(node) || undefined : node.text;
		result.push({ ...node, ...(text !== undefined && { text }), children });
	}

	return result;
}

/** Compact: the reader is a model, and indentation is tokens. */
export function json(value: unknown): string {
	return JSON.stringify(value);
}

/** The focused route as two short lines; the route key is random and tells an agent nothing. */
export function describeRoute({ current, path }: NavigationSummary): string {
	const lines = [
		`route: ${current?.name ?? "?"}${current?.path ? ` (${current.path})` : ""}`,
		`path: ${path.join(" > ")}`,
	];
	if (current?.params !== undefined) lines.push(`params: ${JSON.stringify(current.params)}`);
	return lines.join("\n");
}

type FlatNode = Omit<UINode, "children">;

function flatten(nodes: UINode[], into: Map<number, FlatNode> = new Map()): Map<number, FlatNode> {
	for (const node of nodes) {
		const { children, frame, visible, ...rest } = node;
		into.set(node.id, rest);
		flatten(children, into);
	}
	return into;
}

function nodeChanged(a: FlatNode, b: FlatNode): string[] {
	const fields: Array<keyof FlatNode> = ["text", "value", "label", "pressable", "input", "scrollable", "type"];
	return fields.filter((f) => a[f] !== b[f]).map(String);
}

export type TreeDiff = { added: UINode[]; removed: number[]; changed: Array<{ node: FlatNode; fields: string[] }> };

export function diffTrees(previous: UINode[] | null, next: UINode[]): TreeDiff {
	const before = previous ? flatten(previous) : new Map<number, FlatNode>();
	const after = flatten(next);

	const removed = [...before.keys()].filter((id) => !after.has(id));
	const changed: TreeDiff["changed"] = [];
	const addedIds = new Set<number>();

	for (const [id, node] of after) {
		const old = before.get(id);
		if (!old) {
			addedIds.add(id);
			continue;
		}
		const fields = nodeChanged(old, node);
		if (fields.length) changed.push({ node, fields });
	}

	const added = collectSubtrees(next, addedIds);

	return { added, removed, changed };
}

function collectSubtrees(nodes: UINode[], ids: Set<number>): UINode[] {
	const result: UINode[] = [];
	for (const node of nodes) {
		const isOneOfTheSubtreeRoots = ids.has(node.id);
		if (isOneOfTheSubtreeRoots) result.push(node);
		else result.push(...collectSubtrees(node.children, ids));
	}
	return result;
}

export function formatDiff(diff: TreeDiff): string {
	const lines: string[] = [];
	for (const node of diff.added) {
		lines.push(`+ ${describeLine(node, false)}`);
		for (const line of outline(node.children, false, 1)) lines.push(`+ ${line}`);
	}

	for (const { node, fields } of diff.changed)
		lines.push(`~ ${describeLine(node as UINode, false)} (${fields.join(",")})`);

	for (const id of diff.removed) lines.push(`- #${id}`);

	return lines.length ? lines.join("\n") : "(no changes)";
}

/** Four decimals: two would drift several points down a tall screen. */
const MULTIPLIER_DECIMALS = 4;

/** How to turn a coordinate read off a screenshot back into a screen point. */
export function coordinateHint(shot: Screenshot): string {
	if (!shot.region) return "the point size of this screen is unknown, so coordinates cannot be converted";

	const pointsPerPixel = shot.region.width / shot.width;
	const multiplier = Number(pointsPerPixel.toFixed(MULTIPLIER_DECIMALS));
	const steps = [shot.inPoints ? "1px = 1pt" : `multiply by ${multiplier}`];
	const isOffset = shot.region.x !== 0 || shot.region.y !== 0;
	if (isOffset) steps.push(`add (${Math.round(shot.region.x)},${Math.round(shot.region.y)})`);

	return `${steps.join(", then ")} for tap/swipe`;
}
