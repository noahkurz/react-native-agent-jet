import type { UINode } from "../protocol";

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

export type Snapshot = { roots: UINode[]; all: SemanticNode[] };

export type Measurable = {
	measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
	focus?: () => void;
	blur?: () => void;
	setNativeProps?: (props: Record<string, unknown>) => void;
};
