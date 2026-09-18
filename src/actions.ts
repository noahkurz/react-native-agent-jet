import { describeNode, find, findOne, publicInstanceOf, type Fiber, type SemanticNode } from "./tree";
import type { Target, UINode } from "./protocol";

function syntheticPressEvent() {
	return {
		nativeEvent: { locationX: 0, locationY: 0, pageX: 0, pageY: 0, timestamp: Date.now() },
		persist() {},
		preventDefault() {},
		stopPropagation() {},
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
	};
}

function pressableAncestor(semantic: SemanticNode): SemanticNode | null {
	for (let current: SemanticNode | null = semantic; current; current = current.parent) {
		if (current.onPress) return current;
	}
	return null;
}

export async function press(target: Target, index?: number): Promise<UINode> {
	if (index !== undefined) {
		const pressable = pressableAncestor(await findOne(target, false, index));
		if (!pressable) throw new Error(`Element at index ${index} of ${JSON.stringify(target)} has no pressable ancestor`);
		pressable.onPress?.(syntheticPressEvent());
		return describeNode(pressable);
	}
	const matches = await find(target, false);
	if (matches.length === 0) throw new Error(`No visible element matches ${JSON.stringify(target)}`);
	const pressable = matches.map(pressableAncestor).find((candidate): candidate is SemanticNode => candidate !== null);
	if (!pressable) {
		throw new Error(
			`No pressable element matches ${JSON.stringify(target)} (matched ${matches.length} element(s), none with an onPress; pass an explicit target type or index)`,
		);
	}
	pressable.onPress?.(syntheticPressEvent());
	return describeNode(pressable);
}

function inputFrom(semantic: SemanticNode): SemanticNode | null {
	for (let current: SemanticNode | null = semantic; current; current = current.parent) {
		if (current.node.input) return current;
	}
	return null;
}

async function resolveInput(target: Target, index?: number): Promise<SemanticNode> {
	if (index !== undefined) {
		const input = inputFrom(await findOne(target, false, index));
		if (!input) throw new Error(`Element at index ${index} of ${JSON.stringify(target)} is not a text input`);
		return input;
	}
	const matches = await find(target, false);
	if (matches.length === 0) throw new Error(`No visible element matches ${JSON.stringify(target)}`);
	const input = matches.map(inputFrom).find((candidate): candidate is SemanticNode => candidate !== null);
	if (!input)
		throw new Error(
			`No text input matches ${JSON.stringify(target)} (matched ${matches.length} element(s), none an input)`,
		);
	return input;
}

export async function focus(target: Target, index?: number): Promise<UINode> {
	const input = await resolveInput(target, index);
	const instance = publicInstanceOf(input.fiber);
	if (!instance?.focus) throw new Error("Input has no focus() on its native instance");
	instance.focus();
	return describeNode(input);
}

function onChangeTextOf(fiber: Fiber): ((text: string) => void) | undefined {
	for (let current: Fiber | null = fiber; current; current = current.return) {
		const props = current.memoizedProps as { onChangeText?: unknown } | null;
		if (props && typeof props.onChangeText === "function") return props.onChangeText as (text: string) => void;
	}
	return undefined;
}

export async function setText(target: Target, text: string, index?: number): Promise<UINode & { via: string[] }> {
	const input = await resolveInput(target, index);
	const via: string[] = [];
	const instance = publicInstanceOf(input.fiber);
	if (instance?.setNativeProps) {
		try {
			instance.setNativeProps({ text });
			via.push("setNativeProps");
		} catch {}
	}
	const onChangeText = onChangeTextOf(input.fiber);
	if (onChangeText) {
		onChangeText(text);
		via.push("onChangeText");
	}
	if (via.length === 0) throw new Error("Could not set text: no setNativeProps and no onChangeText handler");
	return { ...describeNode(input), via };
}

function nearestScrollable(semantic: SemanticNode): SemanticNode {
	for (let current: SemanticNode | null = semantic; current; current = current.parent) {
		if (current.scrollInstance) return current;
	}
	throw new Error(`Element ${JSON.stringify(describeNode(semantic))} has no scrollable ancestor`);
}

export async function scroll(params: {
	target?: Target;
	index?: number;
	x?: number;
	y?: number;
	toEnd?: boolean;
}): Promise<UINode> {
	const match = await findOne(params.target ?? { type: "ScrollView" }, false, params.index);
	const scrollable = nearestScrollable(match);
	const instance = scrollable.scrollInstance!;
	if (params.toEnd) instance.scrollToEnd({ animated: false });
	else instance.scrollTo({ x: params.x ?? 0, y: params.y ?? 0, animated: false });
	return describeNode(scrollable);
}
