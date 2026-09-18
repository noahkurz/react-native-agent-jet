import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Fiber } from "../src/tree/types";

// the walker reads layout/style helpers from react-native; stub them so it runs under node
mock.module("react-native", () => ({
	StyleSheet: { flatten: (style: unknown) => style },
	Dimensions: { get: () => ({ width: 400, height: 800 }) },
}));

const HOST = 5;
const HOST_TEXT = 6;

/** Build a fiber, wiring children into the child/sibling shape React uses. */
function fiber(over: Partial<Fiber> & { type?: unknown }, children: Fiber[] = []): Fiber {
	const node = {
		tag: 0,
		type: "View",
		memoizedProps: {},
		stateNode: null,
		child: null,
		sibling: null,
		return: null,
		alternate: null,
		...over,
	} as Fiber;
	children.forEach((child, i) => {
		(child as { return: Fiber | null }).return = node;
		if (i === 0) (node as { child: Fiber | null }).child = child;
		else (children[i - 1] as { sibling: Fiber | null }).sibling = child;
	});
	return node;
}

const host = (type: string, props: Record<string, unknown> = {}, children: Fiber[] = []) =>
	fiber({ tag: HOST, type, memoizedProps: props }, children);

const textNode = (value: string) => fiber({ tag: HOST_TEXT, memoizedProps: value as unknown });

/** Present `root`'s children as the app's fiber roots. */
function mountTree(root: Fiber) {
	(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		renderers: new Map([[1, {}]]),
		getFiberRoots: () => new Set([{ current: root }]),
	};
}

let snapshot: typeof import("../src/tree/walk").snapshot;
let tree: typeof import("../src/tree/query").tree;
let find: typeof import("../src/tree/query").find;
let nameOf: typeof import("../src/tree/walk").nameOf;

beforeAll(async () => {
	({ snapshot, nameOf } = await import("../src/tree/walk"));
	({ tree, find } = await import("../src/tree/query"));
});

describe("what survives the walk", () => {
	test("keeps text, and collapses a wrapper chain into the pressable that owns it", () => {
		// Pressable > View > RCTText("Save") is how a button is really rendered
		mountTree(
			fiber({}, [host("View", { onPress: () => {} }, [host("View", {}, [host("RCTText", {}, [textNode("Save")])])])]),
		);
		const { roots } = snapshot();
		expect(roots).toHaveLength(1);
		expect(roots[0]!.pressable).toBe(true);
		expect(roots[0]!.text).toBe("Save");
	});

	test("drops plain containers that add nothing", () => {
		mountTree(fiber({}, [host("View", {}, [host("View", {}, [host("RCTText", {}, [textNode("hi")])])])]));
		const { roots } = snapshot();
		expect(roots).toHaveLength(1);
		expect(roots[0]!.text).toBe("hi");
	});

	test("reports a text input with its value and placeholder", () => {
		mountTree(fiber({}, [host("RCTSinglelineTextInputView", { value: "qui", placeholder: "Filter" })]));
		const node = snapshot().roots[0]!;
		expect(node.type).toBe("TextInput");
		expect(node.input).toBe(true);
		expect(node.value).toBe("qui");
	});

	test("marks a scroll view using its instance methods", () => {
		mountTree(
			fiber({}, [
				fiber({ tag: HOST, type: "RCTScrollView", stateNode: { scrollTo() {}, scrollToEnd() {} } as unknown }),
			]),
		);
		const node = snapshot().roots[0]!;
		expect(node.type).toBe("ScrollView");
		expect(node.scrollable).toBe(true);
	});

	test("carries testID, accessibility label and role through", () => {
		mountTree(
			fiber({}, [host("View", { testID: "save-btn", accessibilityLabel: "Save", role: "button", onPress: () => {} })]),
		);
		const node = snapshot().roots[0]!;
		expect(node.testID).toBe("save-btn");
		expect(node.label).toBe("Save");
		expect(node.role).toBe("button");
	});
});

describe("what the walk hides", () => {
	test("skips a subtree hidden with display:none", () => {
		mountTree(fiber({}, [host("View", { style: { display: "none" } }, [host("RCTText", {}, [textNode("secret")])])]));
		expect(snapshot().roots).toHaveLength(0);
	});

	test("skips an inactive navigator screen", () => {
		// react-navigation renders react-native-screens, so activityState lands on an RNSScreen host
		mountTree(fiber({}, [host("RNSScreen", { activityState: 0 }, [host("RCTText", {}, [textNode("behind")])])]));
		expect(snapshot().roots).toHaveLength(0);
	});

	test("only react-native-screens may hide a subtree with active={false}", () => {
		// regression: any component taking an `active` prop (tabs, chips, carousels) had its whole
		// subtree hidden from the agent
		mountTree(fiber({}, [host("Chip", { active: false }, [host("RCTText", {}, [textNode("Neat")])])]));
		expect(snapshot().roots.map((n) => n.text)).toEqual(["Neat"]);
	});

	test("an inactive screens screen is still skipped", () => {
		mountTree(fiber({}, [host("RNSScreen", { active: 0 }, [host("RCTText", {}, [textNode("behind")])])]));
		expect(snapshot().roots).toHaveLength(0);
	});

	test("skips a subtree hidden from accessibility", () => {
		mountTree(fiber({}, [host("View", { accessibilityElementsHidden: true }, [host("RCTText", {}, [textNode("x")])])]));
		expect(snapshot().roots).toHaveLength(0);
	});

	test("in a screen stack only the topmost screen is walked", () => {
		const stack = fiber({ tag: 0, type: "RNSScreenStack" }, [
			host("RCTText", {}, [textNode("covered")]),
			host("RCTText", {}, [textNode("on top")]),
		]);
		mountTree(fiber({}, [stack]));
		const texts = snapshot().roots.map((n) => n.text);
		expect(texts).toEqual(["on top"]);
	});
});

describe("collapsing wrappers", () => {
	test("does not merge a pressable child that has its own handler", () => {
		// regression: merging them meant pressing the node fired the outer handler while the tree
		// showed the inner one
		const outer = () => {};
		const inner = () => {};
		mountTree(
			fiber({}, [
				host("View", { onPress: outer }, [host("View", { onPress: inner }, [host("RCTText", {}, [textNode("Row")])])]),
			]),
		);
		const root = snapshot().roots[0]!;
		expect(root.children).toHaveLength(1);
		expect(root.children[0]!.text).toBe("Row");
	});

	test("merges a wrapper that shares the same handler", () => {
		const shared = () => {};
		mountTree(
			fiber({}, [
				host("View", { onPress: shared }, [
					host("View", { onPress: shared }, [host("RCTText", {}, [textNode("Save")])]),
				]),
			]),
		);
		const root = snapshot().roots[0]!;
		expect(root.text).toBe("Save");
		expect(root.children).toHaveLength(0);
	});

	test("never absorbs a child that is an input", () => {
		const shared = () => {};
		mountTree(
			fiber({}, [
				host("View", { onPress: shared }, [host("RCTSinglelineTextInputView", { onPress: shared, value: "x" })]),
			]),
		);
		const root = snapshot().roots[0]!;
		const input = root.children[0] ?? root;
		expect(input.input).toBe(true);
	});
});

describe("node identity", () => {
	test("ids are stable across re-renders via the fiber alternate", () => {
		const first = host("View", { onPress: () => {} });
		mountTree(fiber({}, [first]));
		const before = snapshot().roots[0]!.id;

		// React swaps in the alternate on the next render
		const alternate = host("View", { onPress: () => {} });
		(alternate as { alternate: Fiber | null }).alternate = first;
		(first as { alternate: Fiber | null }).alternate = alternate;
		mountTree(fiber({}, [alternate]));
		expect(snapshot().roots[0]!.id).toBe(before);
	});
});

describe("nameOf", () => {
	test("unwraps forwardRef and memo, and prefers a Tamagui component name", () => {
		expect(nameOf({ type: "RCTView" })).toBe("RCTView");
		expect(nameOf({ type: function Checkout() {} })).toBe("Checkout");
		expect(nameOf({ type: { $$typeof: Symbol.for("react.forward_ref"), render: { name: "Button" } } })).toBe("Button");
		// Tamagui ships forwardRef components whose displayName is unhelpful
		expect(
			nameOf({
				type: {
					$$typeof: Symbol.for("react.forward_ref"),
					displayName: "Themed(Anonymous)",
					staticConfig: { componentName: "Paragraph" },
				},
			}),
		).toBe("Paragraph");
	});

	test("falls back to any name the component object carries", () => {
		expect(nameOf({ type: { displayName: "Card" } })).toBe("Card");
		expect(nameOf({ type: null })).toBe("");
	});
});

describe("finding nodes", () => {
	beforeAll(() => {
		mountTree(
			fiber({}, [
				host("View", { onPress: () => {} }, [host("RCTText", {}, [textNode("Add to cart")])]),
				host("View", { testID: "checkout", onPress: () => {} }, [host("RCTText", {}, [textNode("Checkout")])]),
			]),
		);
	});

	test("a string matches text case-insensitively", async () => {
		expect((await find("add to CART", false)).map((m) => m.node.text)).toEqual(["Add to cart"]);
	});

	test("a string matches a testID exactly", async () => {
		expect((await find("checkout", false))[0]!.node.testID).toBe("checkout");
	});

	test("a selector narrows by field", async () => {
		expect(await find({ text: "Checkout", exact: true }, false)).toHaveLength(1);
		expect(await find({ testID: "nope" }, false)).toHaveLength(0);
	});

	test("tree returns the same nodes as the snapshot", async () => {
		expect((await tree({ layout: false })).map((n) => n.text)).toEqual(["Add to cart", "Checkout"]);
	});
});
