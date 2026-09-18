import { describe, expect, test } from "bun:test";
import type { UINode } from "../src/protocol.js";
import { describeLine, diffTrees, filterTree, formatDiff, outline } from "../host/format.js";

const node = (over: Partial<UINode> & { id: number }): UINode => ({
	type: "View",
	children: [],
	...over,
});

describe("describeLine", () => {
	test("omits coordinates unless frames are asked for", () => {
		const button = node({
			id: 1,
			type: "Pressable",
			text: "Save",
			pressable: true,
			frame: { x: 1, y: 2, width: 3, height: 4 },
		});
		expect(describeLine(button, false)).toBe('#1 Pressable "Save" [press]');
		expect(describeLine(button, true)).toContain("@(1,2 3x4)");
	});

	test("shows input value and placeholder", () => {
		const input = node({ id: 2, type: "TextInput", input: true, value: "qui", placeholder: "Filter" });
		expect(describeLine(input, false)).toBe('#2 TextInput [input] value="qui" placeholder="Filter"');
	});
});

describe("filterTree", () => {
	const tree = [
		node({
			id: 1,
			children: [
				node({ id: 2, type: "Text", text: "heading" }),
				node({ id: 3, type: "Pressable", pressable: true, text: "Go" }),
			],
		}),
	];

	test("interactive keeps actionable nodes and the ancestors that reach them", () => {
		const kept = filterTree(tree, { interactive: true });
		expect(kept).toHaveLength(1);
		expect(kept[0]!.children.map((c) => c.id)).toEqual([3]);
	});

	test("maxDepth stops descending", () => {
		expect(filterTree(tree, { maxDepth: 1 })[0]!.children).toHaveLength(0);
	});

	test("without options the tree is unchanged", () => {
		expect(outline(filterTree(tree, {}), false)).toEqual(outline(tree, false));
	});
});

describe("diffTrees", () => {
	const before = [node({ id: 1, type: "Text", text: "0" })];

	test("reports only the node whose text changed", () => {
		const after = [node({ id: 1, type: "Text", text: "1" })];
		const diff = diffTrees(before, after);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(1);
		expect(formatDiff(diff)).toBe('~ #1 Text "1" (text)');
	});

	test("reports added and removed subtrees", () => {
		const after = [node({ id: 2, type: "Text", text: "new" })];
		const diff = diffTrees(before, after);
		expect(diff.removed).toEqual([1]);
		expect(diff.added.map((n) => n.id)).toEqual([2]);
	});

	test("an unchanged tree produces no diff", () => {
		expect(formatDiff(diffTrees(before, before))).toBe("(no changes)");
	});

	test("with no baseline everything counts as added", () => {
		expect(diffTrees(null, before).added).toHaveLength(1);
	});

	test("ignores frame changes, so scrolling alone is not reported as a change", () => {
		const moved = [node({ id: 1, type: "Text", text: "0", frame: { x: 0, y: 99, width: 1, height: 1 } })];
		expect(diffTrees(before, moved).changed).toHaveLength(0);
	});
});
