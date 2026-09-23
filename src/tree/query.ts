import type { Selector, Target, TreeParams, UINode } from "../protocol";
import { measureAll } from "./measure";
import { snapshot } from "./walk";
import type { SemanticNode } from "./types";

function pruneInvisible(nodes: UINode[]): UINode[] {
	return nodes
		.filter((node) => node.visible !== false)
		.map((node) => ({ ...node, children: pruneInvisible(node.children) }));
}

export async function tree(params: TreeParams): Promise<UINode[]> {
	const snap = snapshot();
	const layoutWasRequested = params.layout !== false;
	if (layoutWasRequested) await measureAll(snap.all);
	const everyNodeWasRequested = params.visibleOnly === false;
	return everyNodeWasRequested ? snap.roots : pruneInvisible(snap.roots);
}

function textMatches(haystack: string | undefined, needle: string, exact: boolean | undefined): boolean {
	if (haystack === undefined) return false;
	if (exact) return haystack === needle;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function toSelector(target: Target): Selector {
	return typeof target === "string" ? { text: target } : target;
}

const ID_AS_THE_TREE_PRINTS_IT = /^#(\d+)$/;

function matchesId(node: UINode, needle: string): boolean {
	const printed = ID_AS_THE_TREE_PRINTS_IT.exec(needle);
	return String(node.id) === (printed ? printed[1] : needle);
}

function matchesString(node: UINode, needle: string): boolean {
	return (
		node.testID === needle ||
		textMatches(node.text, needle, false) ||
		textMatches(node.label, needle, false) ||
		textMatches(node.placeholder, needle, false) ||
		textMatches(node.value, needle, false) ||
		matchesId(node, needle)
	);
}

function matchesSelector(node: UINode, selector: Selector): boolean {
	const testIDMismatches = selector.testID !== undefined && node.testID !== selector.testID;
	const typeMismatches = selector.type !== undefined && node.type !== selector.type;
	const labelMismatches = selector.label !== undefined && !textMatches(node.label, selector.label, selector.exact);
	const textMismatches = selector.text !== undefined && !textMatches(node.text, selector.text, selector.exact);
	return !testIDMismatches && !typeMismatches && !labelMismatches && !textMismatches;
}

export async function find(target: Target, layout: boolean): Promise<SemanticNode[]> {
	const snap = snapshot();
	if (layout) await measureAll(snap.all);
	const visible = snap.all.filter((semantic) => semantic.node.visible !== false);
	const matches =
		typeof target === "string"
			? visible.filter((semantic) => matchesString(semantic.node, target))
			: visible.filter((semantic) => matchesSelector(semantic.node, target));
	return matches;
}

export async function findOne(target: Target, layout: boolean, index?: number): Promise<SemanticNode> {
	const matches = await find(target, layout);
	index ??= typeof target === "string" ? 0 : (target.index ?? 0);
	const match = matches[index];
	if (!match) {
		throw new Error(
			matches.length === 0
				? `No element matches ${JSON.stringify(target)}`
				: `Only ${matches.length} elements match ${JSON.stringify(target)}, index ${index} is out of range`,
		);
	}
	return match;
}

export function describeNode(semantic: SemanticNode): UINode {
	return { ...semantic.node, children: [] };
}
