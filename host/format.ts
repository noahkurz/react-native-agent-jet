import type { UINode } from "../src/protocol.js";

const TEXT_LIMIT = 80;

function quote(value: string): string {
	const trimmed = value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
	return JSON.stringify(trimmed);
}

export function describeLine(node: UINode, frames = true): string {
	const parts = [`#${node.id}`, node.type];
	if (node.testID) parts.push(`testID=${quote(node.testID)}`);
	if (node.label) parts.push(`label=${quote(node.label)}`);
	if (node.role) parts.push(`role=${node.role}`);
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

export function filterTree(nodes: UINode[], opts: { interactive?: boolean; maxDepth?: number }, depth = 0): UINode[] {
	const askedForNoLevelsAtAll = opts.maxDepth !== undefined && opts.maxDepth < 1;
	if (askedForNoLevelsAtAll) return [];

	const result: UINode[] = [];
	for (const node of nodes) {
		const atDepthLimit = opts.maxDepth !== undefined && depth + 1 >= opts.maxDepth;
		const children = atDepthLimit ? [] : filterTree(node.children, opts, depth + 1);
		const nothingHereToActOn = Boolean(opts.interactive) && !isActionable(node) && children.length === 0;
		if (nothingHereToActOn) continue;

		result.push({ ...node, children });
	}

	return result;
}

export function json(value: unknown): string {
	return JSON.stringify(value, null, 1);
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
