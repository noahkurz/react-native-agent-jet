import { DevSettings, Dimensions, PixelRatio, Platform } from "react-native";
import { focus, press, scroll, setText } from "./actions";
import { clearCapture, readLogs, readNetwork } from "./capture";
import { describeNode, find, tree } from "./tree";
import { appName, goBack, navigateTo, navigationSummary, readState } from "./handles";
import type { BridgeMethods, DeviceInfo, MethodName } from "./protocol";

export function deviceInfo(): DeviceInfo {
	const window = Dimensions.get("window");
	const screen = Dimensions.get("screen");
	return {
		platform: Platform.OS,
		windowWidth: window.width,
		windowHeight: window.height,
		screenWidth: screen.width,
		screenHeight: screen.height,
		pixelRatio: PixelRatio.get(),
		fontScale: PixelRatio.getFontScale(),
		appName: appName(),
	};
}

type Handlers = {
	[M in MethodName]: (
		params: BridgeMethods[M]["params"],
	) => Promise<BridgeMethods[M]["result"]> | BridgeMethods[M]["result"];
};

const handlers: Handlers = {
	ping: () => ({ ok: true }),
	device: () => deviceInfo(),
	tree: (params) => tree(params),
	find: async ({ target }) => (await find(target, true)).map(describeNode),
	press: ({ target, index }) => press(target, index),
	focus: ({ target, index }) => focus(target, index),
	setText: ({ target, text, index }) => setText(target, text, index),
	scroll: (params) => scroll(params),
	navigate: ({ name, params }) => navigateTo(name, params),
	goBack: () => goBack(),
	navState: () => navigationSummary(),
	state: ({ key }) => readState(key),
	logs: ({ since, level }) => readLogs(since, level),
	network: ({ since }) => readNetwork(since),
	clear: () => {
		clearCapture();
		return { ok: true };
	},
	reload: () => {
		setTimeout(() => DevSettings.reload(), 50);
		return { ok: true };
	},
};

export async function dispatch(method: string, params: unknown): Promise<unknown> {
	const isKnownMethod = Object.hasOwn(handlers, method);
	if (!isKnownMethod) throw new Error(`Unknown method "${method}"`);
	const handler = handlers[method as MethodName] as (params: unknown) => unknown;
	return handler(params ?? {});
}
