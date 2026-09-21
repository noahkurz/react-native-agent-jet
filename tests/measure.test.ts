import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { UINode } from "../src/protocol";
import type { Fiber, SemanticNode } from "../src/tree/types";
import { HOST_COMPONENT } from "../src/tree/names";

const WINDOW = { width: 400, height: 800 };
const STATUS_BAR_HEIGHT = 54;

/** What the fake react-native reports; tests change it to move between platforms. */
const native = {
	os: "ios",
	statusBarHeight: undefined as number | undefined,
	isEdgeToEdge: undefined as boolean | undefined,
};

mock.module("react-native", () => ({
	Dimensions: { get: () => WINDOW },
	Platform: {
		get OS() {
			return native.os;
		},
	},
	StatusBar: {
		get currentHeight() {
			return native.statusBarHeight;
		},
	},
	TurboModuleRegistry: {
		get: (name: string) =>
			name === "DeviceInfo" ? { getConstants: () => ({ isEdgeToEdge: native.isEdgeToEdge }) } : null,
	},
}));

let measureAll: typeof import("../src/tree/measure").measureAll;

beforeAll(async () => {
	({ measureAll } = await import("../src/tree/measure"));
});

/** A semantic node whose host view measures at the given window frame. */
function elementAt(x: number, y: number, width = 56, height = 56): SemanticNode {
	const fiber = {
		tag: HOST_COMPONENT,
		type: "View",
		memoizedProps: {},
		stateNode: { measureInWindow: (report: (...frame: number[]) => void) => report(x, y, width, height) },
		child: null,
		sibling: null,
		return: null,
		alternate: null,
	} as Fiber;
	const node: UINode = { id: 1, type: "View", children: [] };
	return { node, fiber, parent: null, textParts: [] };
}

async function measured(element: SemanticNode): Promise<UINode> {
	await measureAll([element]);
	return element.node;
}

const onIos = () => Object.assign(native, { os: "ios", statusBarHeight: undefined, isEdgeToEdge: undefined });
const onAndroid = (isEdgeToEdge: boolean | undefined) =>
	Object.assign(native, { os: "android", statusBarHeight: STATUS_BAR_HEIGHT, isEdgeToEdge });

describe("frames are reported on the screen, not in the window", () => {
	test("iOS windows cover the screen, so frames are used as measured", async () => {
		onIos();
		const node = await measured(elementAt(10, 20));
		expect(node.frame).toEqual({ x: 10, y: 20, width: 56, height: 56 });
	});

	test("an Android window below the status bar moves frames down by its height", async () => {
		onAndroid(false);
		const node = await measured(elementAt(10, 20));
		expect(node.frame).toEqual({ x: 10, y: 20 + STATUS_BAR_HEIGHT, width: 56, height: 56 });
	});

	test("older React Native does not say whether it is edge to edge, so the status bar is assumed", async () => {
		onAndroid(undefined);
		const node = await measured(elementAt(10, 20));
		expect(node.frame?.y).toBe(20 + STATUS_BAR_HEIGHT);
	});

	test("an edge-to-edge Android window already starts at the top of the screen", async () => {
		onAndroid(true);
		const node = await measured(elementAt(10, 20));
		expect(node.frame).toEqual({ x: 10, y: 20, width: 56, height: 56 });
	});

	test("frames are whole points: a tap cannot resolve less and decimals cost tokens", async () => {
		onIos();
		const node = await measured(elementAt(189.3, 242.7, 61.3, 19.5));
		expect(node.frame).toEqual({ x: 189, y: 243, width: 61, height: 20 });
	});

	test("a status bar height React Native cannot report is treated as zero", async () => {
		onAndroid(false);
		native.statusBarHeight = undefined;
		const node = await measured(elementAt(10, 20));
		expect(node.frame?.y).toBe(20);
	});
});

describe("visibility follows the window wherever it sits on the screen", () => {
	test("an element at the bottom of a lowered window is still visible", async () => {
		onAndroid(false);
		const node = await measured(elementAt(0, WINDOW.height - 20, 56, 20));
		expect(node.visible).toBe(true);
	});

	test("an element scrolled above a lowered window is not visible, even though it is on the screen", async () => {
		onAndroid(false);
		const node = await measured(elementAt(0, -30, 56, 20));
		expect(node.frame?.y).toBe(-30 + STATUS_BAR_HEIGHT);
		expect(node.visible).toBe(false);
	});

	test("an element with no size is not visible", async () => {
		onIos();
		const node = await measured(elementAt(10, 20, 0, 0));
		expect(node.visible).toBe(false);
	});
});
