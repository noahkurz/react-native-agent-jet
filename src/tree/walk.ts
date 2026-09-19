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
	RN_SCREEN_PREFIX,
} from "./names";
import type { Fiber, ScrollInstance, SemanticNode, Snapshot } from "./types";

type Props = Record<string, unknown>;

type DevtoolsHook = {
	renderers: Map<number, unknown>;
	getFiberRoots(rendererId: number): Set<{ current: Fiber }>;
};

const fiberIds = new WeakMap<Fiber, number>();
let nextFiberId = 1;

function devtoolsHook(): DevtoolsHook | undefined {
	return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
}

export function rootFibers(): Fiber[] {
	const hook = devtoolsHook();
	const hookCanEnumerateRoots = Boolean(hook?.renderers) && typeof hook?.getFiberRoots === "function";
	if (!hookCanEnumerateRoots) return [];
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
	const canCarryAName = Boolean(raw) && (typeof raw === "object" || typeof raw === "function");
	if (!canCarryAName) return "";
	const type = raw as NamedType;
	const tamagui = type.staticConfig?.componentName;
	if (typeof raw === "function") {
		return tamagui || type.displayName || type.name || "Anonymous";
	}
	if (type.$$typeof === REACT_FORWARD_REF) {
		const own = type.displayName || type.render?.displayName || type.render?.name;
		const ownNameIsMeaningful = Boolean(own) && !GENERIC_NAMES.has(own as string);
		return ownNameIsMeaningful ? (own as string) : tamagui || own || "ForwardRef";
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

function isInactiveScreen(name: string, props: Props): boolean {
	const isNavigatorScreen = name.startsWith(RN_SCREEN_PREFIX);
	if (!isNavigatorScreen) return false;
	return props.activityState === 0 || props.active === 0 || props.active === false;
}

function isHiddenSubtree(name: string, props: Props): boolean {
	const hiddenFromAccessibility = props.accessibilityElementsHidden === true || props["aria-hidden"] === true;
	const hiddenFromDescendants = props.importantForAccessibility === "no-hide-descendants";
	if (isInactiveScreen(name, props) || hiddenFromAccessibility || hiddenFromDescendants) return true;
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
	const isMeaningfulOnItsOwn = info.isText || info.input || Boolean(info.scrollInstance);
	const hasItsOwnTestID = Boolean(info.testID) && info.testID !== parent.node.testID;
	const hasItsOwnLabel = Boolean(info.label) && info.label !== parent.node.label;
	const hasItsOwnRole = Boolean(info.role) && info.role !== parent.node.role;
	const hasItsOwnPressHandler = info.pressable && info.onPress !== parent.onPress;
	return isMeaningfulOnItsOwn || hasItsOwnTestID || hasItsOwnLabel || hasItsOwnRole || hasItsOwnPressHandler;
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
	const name = nameOf(fiber);
	const subtreeIsHidden = props !== null && isHiddenSubtree(name, props);
	if (subtreeIsHidden) return;
	const screenStackChild = name === RN_SCREEN_STACK ? fiber.child : null;
	if (screenStackChild) {
		visit(lastSibling(screenStackChild), parent, all);
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

function addsNoIdentityOfItsOwn(child: UINode, parent: UINode): boolean {
	return (
		(!child.testID || child.testID === parent.testID) &&
		(!child.label || child.label === parent.label) &&
		(!child.role || child.role === parent.role)
	);
}

function isBareLeaf(child: UINode): boolean {
	return child.children.length === 0 && !child.pressable && !child.input && !child.scrollable;
}

function isTheSameControl(child: SemanticNode, parent: SemanticNode): boolean {
	return (
		parent.node.pressable === true &&
		child.node.pressable === true &&
		child.onPress === parent.onPress &&
		!child.node.input &&
		!child.node.scrollable
	);
}

function finalize(semantic: SemanticNode, all: SemanticNode[]): void {
	const text = semantic.textParts.join("").trim();
	if (text) semantic.node.text = text;
	const only = semantic.node.children.length === 1 ? semantic.node.children[0] : undefined;
	if (!only) return;
	const onlySemantic = all.find((candidate) => candidate.node === only);
	if (!onlySemantic) return;
	const absorbsText =
		isBareLeaf(only) && addsNoIdentityOfItsOwn(only, semantic.node) && (!only.text || !semantic.node.text);
	const absorbsWrapper =
		isTheSameControl(onlySemantic, semantic) && !semantic.node.text && addsNoIdentityOfItsOwn(only, semantic.node);
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
