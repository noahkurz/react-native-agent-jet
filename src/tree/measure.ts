import { Dimensions, Platform, StatusBar, TurboModuleRegistry } from "react-native";
import type { Frame, Point } from "../protocol";
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

type DeviceInfoModule = { getConstants?: () => { isEdgeToEdge?: boolean } };

function drawsEdgeToEdge(): boolean {
	return TurboModuleRegistry.get<DeviceInfoModule>("DeviceInfo")?.getConstants?.().isEdgeToEdge === true;
}

/**
 * Where the window sits on the screen. measureInWindow answers in window coordinates, but taps
 * land and screenshots are taken on the screen. On iOS the two are the same. On Android the
 * window starts below the status bar unless the app draws edge to edge — the inset React
 * Native itself subtracts when it places the root view — so frames are moved onto the screen
 * here, once, rather than corrected by every tool that touches it.
 */
function windowOrigin(): Point {
	const startsBelowTheStatusBar = Platform.OS === "android" && !drawsEdgeToEdge();
	return { x: 0, y: startsBelowTheStatusBar ? (StatusBar.currentHeight ?? 0) : 0 };
}

/** The element's frame on the screen, in whole points: a tap cannot resolve less, and decimals cost tokens. */
function measure(fiber: Fiber, origin: Point): Promise<Frame | undefined> {
	const instance = publicInstanceOf(fiber);
	if (!instance) return Promise.resolve(undefined);

	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), MEASURE_TIMEOUT_MS);
		try {
			instance.measureInWindow((x, y, width, height) => {
				clearTimeout(timer);
				resolve({
					x: Math.round(x + origin.x),
					y: Math.round(y + origin.y),
					width: Math.round(width),
					height: Math.round(height),
				});
			});
		} catch {
			clearTimeout(timer);
			resolve(undefined);
		}
	});
}

function overlaps(frame: Frame, area: Frame): boolean {
	return (
		frame.width > 0 &&
		frame.height > 0 &&
		frame.x < area.x + area.width &&
		frame.x + frame.width > area.x &&
		frame.y < area.y + area.height &&
		frame.y + frame.height > area.y
	);
}

export async function measureAll(all: SemanticNode[]): Promise<void> {
	const window: Frame = { ...windowOrigin(), ...Dimensions.get("window") };
	const frames = await Promise.all(all.map((semantic) => measure(semantic.fiber, window)));
	all.forEach((semantic, index) => {
		const frame = frames[index];
		if (!frame) return;
		semantic.node.frame = frame;
		semantic.node.visible = overlaps(frame, window);
	});
}
