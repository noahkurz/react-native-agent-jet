import { describe, expect, test } from "bun:test";
import type { UINode } from "../src/protocol.js";
import type { Screenshot } from "../host/image.js";
import {
	coordinateHint,
	describeLine,
	describeRoute,
	diffTrees,
	filterTree,
	formatDiff,
	outline,
} from "../host/format.js";

const node = (over: Partial<UINode> & { id: number }): UINode => ({
	type: "View",
	children: [],
	...over,
});

describe("describeLine", () => {
	test("role=button adds nothing to a pressable, so it is left out", () => {
		expect(describeLine(node({ id: 1, type: "Pressable", role: "button", pressable: true, text: "Go" }))).toBe(
			'#1 Pressable "Go" [press]',
		);
		expect(describeLine(node({ id: 2, type: "View", role: "button", text: "Go" }))).toBe('#2 View role=button "Go"');
		expect(describeLine(node({ id: 3, type: "View", role: "tab", pressable: true }))).toBe("#3 View role=tab [press]");
	});

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

	test("a maxDepth below one returns nothing rather than bare roots", () => {
		expect(filterTree(tree, { maxDepth: 0 })).toEqual([]);
		expect(filterTree(tree, { maxDepth: -1 })).toEqual([]);
	});

	test("without options the tree is unchanged", () => {
		expect(outline(filterTree(tree, {}), false)).toEqual(outline(tree, false));
	});

	test("interactive keeps the text of a row it strips, so the row still says what it is", () => {
		const row = node({
			id: 10,
			type: "Pressable",
			pressable: true,
			children: [node({ id: 11, type: "Text", text: "#1" }), node({ id: 12, type: "Text", text: "sunt aut facere" })],
		});
		const [kept] = filterTree([row], { interactive: true });
		expect(kept!.text).toBe("#1 sunt aut facere");
		expect(kept!.children).toEqual([]);
	});

	test("a summary does not reach into controls that are kept anyway", () => {
		const card = node({
			id: 20,
			type: "Pressable",
			pressable: true,
			children: [
				node({ id: 21, type: "Text", text: "Title" }),
				node({ id: 22, type: "Pressable", pressable: true, text: "Delete" }),
			],
		});
		const [kept] = filterTree([card], { interactive: true });
		expect(kept!.text).toBe("Title");
		expect(kept!.children.map((child) => child.id)).toEqual([22]);
	});

	test("a labelled control and a scroll container are not summarised", () => {
		const tab = node({
			id: 40,
			pressable: true,
			label: "Home, tab, 1 of 3",
			children: [node({ id: 41, text: "Home" })],
		});
		const list = node({ id: 42, scrollable: true, children: [node({ id: 43, text: "heading" })] });
		const kept = filterTree([tab, list], { interactive: true });
		expect(kept.map((item) => item.text)).toEqual([undefined, undefined]);
	});

	test("a repeated fragment is summarised once", () => {
		const row = node({
			id: 50,
			pressable: true,
			children: [node({ id: 51, text: "⌂" }), node({ id: 52, text: "⌂" }), node({ id: 53, text: "Home" })],
		});
		expect(filterTree([row], { interactive: true })[0]!.text).toBe("⌂ Home");
	});

	test("a control with text of its own is not summarised over", () => {
		const [kept] = filterTree(
			[node({ id: 30, pressable: true, text: "Save", children: [node({ id: 31, text: "x" })] })],
			{
				interactive: true,
			},
		);
		expect(kept!.text).toBe("Save");
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

describe("diffing a filtered tree", () => {
	const withCounter = (value: string): UINode[] => [
		{
			id: 1,
			type: "View",
			children: [
				{ id: 2, type: "Text", text: value, children: [] },
				{ id: 3, type: "Pressable", pressable: true, children: [] },
			],
		},
	];

	test("a change to a non-interactive node is invisible under the interactive filter", () => {
		const only = { interactive: true };
		const diff = diffTrees(filterTree(withCounter("1"), only), filterTree(withCounter("2"), only));
		expect(formatDiff(diff)).toBe("(no changes)");
	});

	test("the same change is reported when nothing is filtered out", () => {
		const diff = diffTrees(withCounter("1"), withCounter("2"));
		expect(formatDiff(diff)).toContain("#2");
	});
});

describe("coordinateHint", () => {
	const shot = (over: Partial<Screenshot>): Screenshot => ({
		path: "/tmp/shot.png",
		width: 440,
		inPoints: true,
		region: { x: 0, y: 0, width: 440, height: 956 },
		cropped: false,
		...over,
	});

	test("says so when there is no way to convert", () => {
		expect(coordinateHint(shot({ region: null }))).toMatch(/unknown/);
	});

	test("a full-detail screen needs no conversion", () => {
		expect(coordinateHint(shot({}))).toBe("1px = 1pt for tap/swipe");
	});

	test("a halved screen gives the multiplier", () => {
		expect(coordinateHint(shot({ width: 220, inPoints: false }))).toBe("multiply by 2 for tap/swipe");
	});

	test("a crop also gives the origin to add back", () => {
		const cropped = shot({ width: 424, region: { x: 8, y: 108, width: 424, height: 104 }, cropped: true });
		expect(coordinateHint(cropped)).toBe("1px = 1pt, then add (8,108) for tap/swipe");
	});

	test("keeps enough precision that the error stays under a pixel down a tall screen", () => {
		// Two decimals would say 0.33, drifting ~9pt by the bottom of a 2868px capture.
		expect(coordinateHint(shot({ width: 1320, inPoints: false }))).toBe("multiply by 0.3333 for tap/swipe");
	});
});

describe("describeRoute", () => {
	test("gives the focused route and its trail in two lines, without the random route key", () => {
		const summary = {
			current: { name: "index", path: "/", key: "index-A9b7dXSmkcwI1-IoR-1mQ" },
			path: ["__root", "(tabs)", "index"],
		};
		expect(describeRoute(summary)).toBe("route: index (/)\npath: __root > (tabs) > index");
	});

	test("adds params only when the route has them", () => {
		const summary = { current: { name: "detail", params: { id: "42" } }, path: ["__root", "detail"] };
		expect(describeRoute(summary)).toBe('route: detail\npath: __root > detail\nparams: {"id":"42"}');
	});
});
