import { Dimensions, StyleSheet } from "react-native";
import type { Frame, Selector, Target, TreeParams, UINode } from "./protocol";

export type Fiber = {
	tag: number;
	type: unknown;
	memoizedProps: unknown;
	stateNode: unknown;
	child: Fiber | null;
	sibling: Fiber | null;
	return: Fiber | null;
	alternate: Fiber | null;
};

export type SemanticNode = {
	node: UINode;
	fiber: Fiber;
	parent: SemanticNode | null;
	onPress?: (event: unknown) => void;
	scrollInstance?: ScrollInstance;
	textParts: string[];
};

export type ScrollInstance = {
	scrollTo(options: { x?: number; y?: number; animated?: boolean }): void;
	scrollToEnd(options?: { animated?: boolean }): void;
};

type Props = Record<string, unknown>;

type DevtoolsHook = {
	renderers: Map<number, unknown>;
	getFiberRoots(rendererId: number): Set<{ current: Fiber }>;
};

const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const MEASURE_TIMEOUT_MS = 1000;

const fiberIds = new WeakMap<Fiber, number>();
let nextFiberId = 1;

function devtoolsHook(): DevtoolsHook | undefined {
	return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
}

export function rootFibers(): Fiber[] {
	const hook = devtoolsHook();
	if (!hook?.renderers || typeof hook.getFiberRoots !== "function") return [];
	const roots: Fiber[] = [];
	for (const rendererId of hook.renderers.keys()) {
		for (const root of hook.getFiberRoots(rendererId)) {
			if (root.current) roots.push(root.current);
		}
	}
	return roots;
}

function idFor(fiber: Fiber): number {
	const existing = fiberIds.get(fiber) ?? (fiber.alternate ? fiberIds.get(fiber.alternate) : undefined);
	if (existing !== undefined) {
		fiberIds.set(fiber, existing);
		return existing;
	}
	const id = nextFiberId++;
	fiberIds.set(fiber, id);
	if (fiber.alternate) fiberIds.set(fiber.alternate, id);
	return id;
}

const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_MEMO = Symbol.for("react.memo");

type NamedType = {
	displayName?: string;
	name?: string;
	$$typeof?: symbol;
	render?: { displayName?: string; name?: string };
	type?: unknown;
	staticConfig?: { componentName?: string };
};

const GENERIC_NAMES = new Set(["Anonymous", "ForwardRef", "Themed(Anonymous)", "wrapped"]);

export function nameOf(fiber: Pick<Fiber, "type">): string {
	const raw = fiber.type;
	if (typeof raw === "string") return raw;
	if (!raw || (typeof raw !== "object" && typeof raw !== "function")) return "";
	const type = raw as NamedType;
	const tamagui = type.staticConfig?.componentName;
	if (typeof raw === "function") {
		return tamagui || type.displayName || type.name || "Anonymous";
	}
	if (type.$$typeof === REACT_FORWARD_REF) {
		const own = type.displayName || type.render?.displayName || type.render?.name;
		return own && !GENERIC_NAMES.has(own) ? own : tamagui || own || "ForwardRef";
	}
	if (type.$$typeof === REACT_MEMO) {
		return type.displayName || nameOf({ type: type.type });
	}
	return "";
}

function propsOf(fiber: Fiber): Props | null {
	const props = fiber.memoizedProps;
	return props && typeof props === "object" ? (props as Props) : null;
}

function isHiddenSubtree(props: Props): boolean {
	if (props.activityState === 0 || props.active === 0 || props.active === false) return true;
	if (props.accessibilityElementsHidden === true || props["aria-hidden"] === true) return true;
	if (props.importantForAccessibility === "no-hide-descendants") return true;
	const style = props.style
		? (StyleSheet.flatten(props.style as never) as { display?: string } | undefined)
		: undefined;
	return style?.display === "none";
}

function stringProp(props: Props, key: string): string | undefined {
	const value = props[key];
	return typeof value === "string" ? value : undefined;
}

type Described = {
	testID?: string;
	label?: string;
	role?: string;
	pressable: boolean;
	input: boolean;
	value?: string;
	placeholder?: string;
	scrollInstance?: ScrollInstance;
	onPress?: (event: unknown) => void;
	isText: boolean;
};

function describe(fiber: Fiber, name: string, props: Props): Described {
	const isHost = fiber.tag === HOST_COMPONENT;
	const onPress = typeof props.onPress === "function" ? (props.onPress as (event: unknown) => void) : undefined;
	const input = isHost && /TextInput/.test(name);
	const instance = fiber.stateNode as Partial<ScrollInstance> | null;
	const scrollInstance =
		instance && typeof instance.scrollTo === "function" && typeof instance.scrollToEnd === "function"
			? (instance as ScrollInstance)
			: undefined;
	return {
		testID: stringProp(props, "testID"),
		label: stringProp(props, "accessibilityLabel") ?? stringProp(props, "aria-label"),
		role: stringProp(props, "role") ?? stringProp(props, "accessibilityRole"),
		pressable: onPress !== undefined,
		onPress,
		input,
		value: input ? (stringProp(props, "text") ?? stringProp(props, "value")) : undefined,
		placeholder: input ? stringProp(props, "placeholder") : undefined,
		scrollInstance,
		isText: isHost && name === "RCTText",
	};
}

function displayType(name: string, info: Described): string {
	if (info.isText) return "Text";
	if (info.input) return "TextInput";
	if (name === "RCTScrollView") return "ScrollView";
	return name;
}

function addsInformation(info: Described, parent: SemanticNode): boolean {
	if (info.isText || info.input || info.scrollInstance) return true;
	if (info.testID && info.testID !== parent.node.testID) return true;
	if (info.label && info.label !== parent.node.label) return true;
	if (info.role && info.role !== parent.node.role) return true;
	return info.pressable && info.onPress !== parent.onPress;
}

function lastSibling(fiber: Fiber): Fiber {
	let current = fiber;
	while (current.sibling) current = current.sibling;
	return current;
}

function visit(fiber: Fiber, parent: SemanticNode, all: SemanticNode[]): void {
	if (fiber.tag === HOST_TEXT) {
		if (typeof fiber.memoizedProps === "string") parent.textParts.push(fiber.memoizedProps);
		return;
	}
	const props = propsOf(fiber);
	if (props && isHiddenSubtree(props)) return;
	const name = nameOf(fiber);
	if (name === "RNSScreenStack" && fiber.child) {
		visit(lastSibling(fiber.child), parent, all);
		return;
	}
	let current = parent;
	let created: SemanticNode | null = null;
	if (props) {
		const info = describe(fiber, name, props);
		if (addsInformation(info, parent)) {
			const node: UINode = { id: idFor(fiber), type: displayType(name, info), children: [] };
			if (info.testID) node.testID = info.testID;
			if (info.label) node.label = info.label;
			if (info.role) node.role = info.role;
			if (info.pressable) node.pressable = true;
			if (info.input) {
				node.input = true;
				if (info.value !== undefined) node.value = info.value;
				if (info.placeholder !== undefined) node.placeholder = info.placeholder;
			}
			if (info.scrollInstance) node.scrollable = true;
			created = { node, fiber, parent, onPress: info.onPress, scrollInstance: info.scrollInstance, textParts: [] };
			parent.node.children.push(node);
			all.push(created);
			current = created;
		}
	}
	for (let child = fiber.child; child; child = child.sibling) visit(child, current, all);
	if (created) finalize(created, all);
}

function finalize(semantic: SemanticNode, all: SemanticNode[]): void {
	const text = semantic.textParts.join("").trim();
	if (text) semantic.node.text = text;
	const only = semantic.node.children.length === 1 ? semantic.node.children[0] : undefined;
	if (!only) return;
	const onlySemantic = all.find((candidate) => candidate.node === only);
	if (!onlySemantic) return;
	const absorbsText =
		only.children.length === 0 &&
		!only.pressable &&
		!only.input &&
		!only.scrollable &&
		(!only.testID || only.testID === semantic.node.testID) &&
		(!only.label || only.label === semantic.node.label) &&
		(!only.text || !semantic.node.text);
	const absorbsWrapper =
		semantic.node.pressable === true &&
		only.pressable === true &&
		!semantic.node.text &&
		(!only.testID || only.testID === semantic.node.testID) &&
		(!only.label || only.label === semantic.node.label);
	if (!absorbsText && !absorbsWrapper) return;
	if (only.text) semantic.node.text = only.text;
	if (only.testID && !semantic.node.testID) semantic.node.testID = only.testID;
	if (only.label && !semantic.node.label) semantic.node.label = only.label;
	if (only.role && !semantic.node.role) semantic.node.role = only.role;
	semantic.node.children = only.children;
	for (const grandchild of all) {
		if (grandchild.parent === onlySemantic) grandchild.parent = semantic;
	}
	all.splice(all.indexOf(onlySemantic), 1);
}

export type Snapshot = { roots: UINode[]; all: SemanticNode[] };

export function snapshot(): Snapshot {
	const all: SemanticNode[] = [];
	const roots: UINode[] = [];
	for (const rootFiber of rootFibers()) {
		const root: SemanticNode = {
			node: { id: 0, type: "Root", children: roots },
			fiber: rootFiber,
			parent: null,
			textParts: [],
		};
		for (let child = rootFiber.child; child; child = child.sibling) visit(child, root, all);
	}
	return { roots, all };
}

type Measurable = {
	measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
	focus?: () => void;
	blur?: () => void;
	setNativeProps?: (props: Record<string, unknown>) => void;
};

export function hostFiberOf(fiber: Fiber): Fiber | null {
	if (fiber.tag === HOST_COMPONENT) return fiber;
	for (let child = fiber.child; child; child = child.sibling) {
		const found = hostFiberOf(child);
		if (found) return found;
	}
	return null;
}

function isMeasurable(candidate: unknown): candidate is Measurable {
	return !!candidate && typeof (candidate as Measurable).measureInWindow === "function";
}

type FabricStateNode = { node?: unknown; canonical?: { publicInstance?: unknown } };

type FabricUIManager = {
	measureInWindow(node: unknown, callback: (x: number, y: number, width: number, height: number) => void): void;
	dispatchCommand?: (node: unknown, command: string, args: unknown[]) => void;
	setNativeProps?: (node: unknown, props: Record<string, unknown>) => void;
};

function fabricUIManager(): FabricUIManager | undefined {
	return (globalThis as { nativeFabricUIManager?: FabricUIManager }).nativeFabricUIManager;
}

function shadowNodeInstance(stateNode: FabricStateNode): Measurable | null {
	const manager = fabricUIManager();
	if (!manager || !stateNode.node) return null;
	const instance: Measurable = {
		measureInWindow: (callback) => manager.measureInWindow(stateNode.node, callback),
	};
	if (manager.dispatchCommand) {
		instance.focus = () => manager.dispatchCommand!(stateNode.node, "focus", []);
		instance.blur = () => manager.dispatchCommand!(stateNode.node, "blur", []);
	}
	if (manager.setNativeProps) {
		instance.setNativeProps = (props) => manager.setNativeProps!(stateNode.node, props);
	}
	return instance;
}

export function publicInstanceOf(fiber: Fiber): Measurable | null {
	const host = hostFiberOf(fiber);
	if (!host) return null;
	const stateNode = host.stateNode as FabricStateNode | null;
	if (!stateNode) return null;
	if (isMeasurable(stateNode)) return stateNode;
	const canonical = stateNode.canonical;
	if (!canonical) return null;
	if (isMeasurable(canonical.publicInstance)) return canonical.publicInstance;
	return shadowNodeInstance(stateNode);
}

function measure(fiber: Fiber): Promise<Frame | undefined> {
	const instance = publicInstanceOf(fiber);
	if (!instance) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), MEASURE_TIMEOUT_MS);
		try {
			instance.measureInWindow((x, y, width, height) => {
				clearTimeout(timer);
				resolve({ x: round(x), y: round(y), width: round(width), height: round(height) });
			});
		} catch {
			clearTimeout(timer);
			resolve(undefined);
		}
	});
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

function isOnScreen(frame: Frame): boolean {
	const { width, height } = Dimensions.get("window");
	return (
		frame.width > 0 &&
		frame.height > 0 &&
		frame.x + frame.width > 0 &&
		frame.y + frame.height > 0 &&
		frame.x < width &&
		frame.y < height
	);
}

export async function measureAll(all: SemanticNode[]): Promise<void> {
	const frames = await Promise.all(all.map((semantic) => measure(semantic.fiber)));
	all.forEach((semantic, index) => {
		const frame = frames[index];
		if (!frame) return;
		semantic.node.frame = frame;
		semantic.node.visible = isOnScreen(frame);
	});
}

function pruneInvisible(nodes: UINode[]): UINode[] {
	return nodes
		.filter((node) => node.visible !== false)
		.map((node) => ({ ...node, children: pruneInvisible(node.children) }));
}

export async function tree(params: TreeParams): Promise<UINode[]> {
	const snap = snapshot();
	if (params.layout !== false) await measureAll(snap.all);
	return params.visibleOnly === false ? snap.roots : pruneInvisible(snap.roots);
}

function textMatches(haystack: string | undefined, needle: string, exact: boolean | undefined): boolean {
	if (haystack === undefined) return false;
	if (exact) return haystack === needle;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function toSelector(target: Target): Selector {
	return typeof target === "string" ? { text: target } : target;
}

function matchesString(node: UINode, needle: string): boolean {
	return (
		node.testID === needle ||
		textMatches(node.text, needle, false) ||
		textMatches(node.label, needle, false) ||
		textMatches(node.placeholder, needle, false) ||
		textMatches(node.value, needle, false) ||
		String(node.id) === needle
	);
}

function matchesSelector(node: UINode, selector: Selector): boolean {
	if (selector.testID !== undefined && node.testID !== selector.testID) return false;
	if (selector.type !== undefined && node.type !== selector.type) return false;
	if (selector.label !== undefined && !textMatches(node.label, selector.label, selector.exact)) return false;
	if (selector.text !== undefined && !textMatches(node.text, selector.text, selector.exact)) return false;
	return true;
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

export async function inspect(target: Target): Promise<unknown> {
	const semantic = await findOne(target, false);
	const host = hostFiberOf(semantic.fiber);
	const stateNode = host?.stateNode as { canonical?: Record<string, unknown> } | null;
	const chain: string[] = [];
	for (let current: Fiber | null = semantic.fiber; current && chain.length < 12; current = current.child) {
		chain.push(`${current.tag}:${nameOf(current)}`);
	}
	return {
		node: describeNode(semantic),
		chain,
		hostName: host ? nameOf(host) : null,
		stateNodeKeys: stateNode ? Object.keys(stateNode) : null,
		canonicalKeys: stateNode?.canonical ? Object.keys(stateNode.canonical) : null,
		publicInstance: stateNode?.canonical?.publicInstance
			? Object.getOwnPropertyNames(Object.getPrototypeOf(stateNode.canonical.publicInstance))
			: null,
		measurable: publicInstanceOf(semantic.fiber) !== null,
	};
}
