import { Dimensions } from "react-native";
import type { Frame } from "../protocol";
import { HOST_COMPONENT } from "./names";
import type { Fiber, Measurable, SemanticNode } from "./types";

const MEASURE_TIMEOUT_MS = 1000;

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
	const shadowNode = stateNode.node;
	if (!manager || !shadowNode) return null;
	const instance: Measurable = {
		measureInWindow: (callback) => manager.measureInWindow(shadowNode, callback),
	};

	const dispatchCommand = manager.dispatchCommand;
	if (dispatchCommand) {
		instance.focus = () => dispatchCommand(shadowNode, "focus", []);
		instance.blur = () => dispatchCommand(shadowNode, "blur", []);
	}

	const setNativeProps = manager.setNativeProps;
	if (setNativeProps) {
		instance.setNativeProps = (props) => setNativeProps(shadowNode, props);
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
