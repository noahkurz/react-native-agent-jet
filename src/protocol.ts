export type Selector = {
	testID?: string;
	text?: string;
	label?: string;
	type?: string;
	exact?: boolean;
	index?: number;
};

export type Target = string | Selector;

export type Point = { x: number; y: number };

/** A rectangle on the screen, in points — the coordinates tap and swipe take and screenshots show. */
export type Frame = Point & { width: number; height: number };

export type UINode = {
	id: number;
	type: string;
	testID?: string;
	label?: string;
	role?: string;
	text?: string;
	pressable?: boolean;
	input?: boolean;
	value?: string;
	placeholder?: string;
	scrollable?: boolean;
	frame?: Frame;
	visible?: boolean;
	children: UINode[];
};

export type DeviceInfo = {
	platform: string;
	windowWidth: number;
	windowHeight: number;
	screenWidth: number;
	screenHeight: number;
	pixelRatio: number;
	fontScale: number;
	appName?: string;
};

export type LogEntry = {
	seq: number;
	at: number;
	level: "log" | "info" | "warn" | "error" | "debug" | "uncaught";
	message: string;
	stack?: string;
};

export type NetworkEntry = {
	seq: number;
	at: number;
	method: string;
	url: string;
	status?: number;
	durationMs?: number;
	requestBody?: string;
	responseBody?: string;
	error?: string;
};

export type TreeParams = { layout?: boolean; visibleOnly?: boolean };

export type NavigationSummary = {
	/** The focused route as React Navigation reports it: name, and path/params when it has them. */
	current?: { name: string; path?: string; params?: unknown };
	/** Route names from the root navigator down to the focused screen. */
	path: string[];
	/** The whole nested navigation state, compacted. */
	state?: unknown;
};

export type BridgeMethods = {
	ping: { params: Record<string, never>; result: { ok: true } };
	device: { params: Record<string, never>; result: DeviceInfo };
	tree: { params: TreeParams; result: UINode[] };
	find: { params: { target: Target }; result: UINode[] };
	press: { params: { target: Target; index?: number }; result: UINode };
	focus: { params: { target: Target; index?: number }; result: UINode };
	setText: {
		params: { target: Target; text: string; index?: number };
		result: UINode & { via: string[] };
	};
	scroll: {
		params: { target?: Target; index?: number; x?: number; y?: number; toEnd?: boolean };
		result: UINode;
	};
	navigate: {
		params: { name: string; params?: Record<string, unknown> };
		result: { route?: string };
	};
	goBack: { params: Record<string, never>; result: { route?: string } };
	navState: { params: Record<string, never>; result: NavigationSummary };
	state: { params: { key?: string }; result: Record<string, unknown> };
	logs: {
		params: { since?: number; level?: LogEntry["level"] };
		result: LogEntry[];
	};
	network: { params: { since?: number }; result: NetworkEntry[] };
	clear: { params: Record<string, never>; result: { ok: true } };
	reload: { params: Record<string, never>; result: { ok: true } };
};

export type MethodName = keyof BridgeMethods;

export type Request<M extends MethodName = MethodName> = {
	id: number;
	method: M;
	params: BridgeMethods[M]["params"];
};

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export const HELLO = "hello";

export type Hello = { type: typeof HELLO; device: DeviceInfo; version: string };
