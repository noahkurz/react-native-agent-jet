/** Turning React's Fiber tree into the semantic node tree an agent reads. */
import { StyleSheet } from "react-native";
import type { UINode } from "../protocol";
import {
	HOST_COMPONENT,
	HOST_TEXT,
	RN_SCREEN_STACK,
	RN_SCROLL_VIEW,
	RN_TEXT,
	ROOT_TYPE,
	SCROLL_VIEW_TYPE,
	TEXT_INPUT_TYPE,
	TEXT_TYPE,
} from "./names";
import type { Fiber, ScrollInstance, SemanticNode, Snapshot } from "./types";

type Props = Record<string, unknown>;

type DevtoolsHook = {
	renderers: Map<number, unknown>;
	getFiberRoots(rendererId: number): Set<{ current: Fiber }>;
};

/** Ids must survive re-renders, so they are keyed by fiber and shared with its alternate. */
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
	return tamagui || type.displayName || "";
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
		isText: isHost && name === RN_TEXT,
	};
}

function displayType(name: string, info: Described): string {
	if (info.isText) return TEXT_TYPE;
	if (info.input) return TEXT_INPUT_TYPE;
	if (name === RN_SCROLL_VIEW) return SCROLL_VIEW_TYPE;
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
	if (name === RN_SCREEN_STACK && fiber.child) {
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

export function snapshot(): Snapshot {
	const all: SemanticNode[] = [];
	const roots: UINode[] = [];
	for (const rootFiber of rootFibers()) {
		const root: SemanticNode = {
			node: { id: 0, type: ROOT_TYPE, children: roots },
			fiber: rootFiber,
			parent: null,
			textParts: [],
		};
		for (let child = rootFiber.child; child; child = child.sibling) visit(child, root, all);
	}
	return { roots, all };
}
