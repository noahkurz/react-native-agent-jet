import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const native = { os: "ios", reload: mock(() => {}) };
mock.module("react-native", () => ({
	DevSettings: { reload: native.reload },
	Platform: {
		get OS() {
			return native.os;
		},
	},
}));

let reloadBundle: typeof import("../src/reload").reloadBundle;
beforeAll(async () => {
	({ reloadBundle } = await import("../src/reload"));
});

const runtime = globalThis as { expo?: unknown };
afterEach(() => {
	delete runtime.expo;
	native.os = "ios";
	native.reload.mockClear();
});

describe("reloading the bundle", () => {
	test("on iOS goes through Expo's own reload, so Expo Go keeps its native modules", () => {
		const reloadAppAsync = mock(() => Promise.resolve());
		runtime.expo = { reloadAppAsync };
		reloadBundle();
		expect(reloadAppAsync).toHaveBeenCalledWith("Reloaded by react-native-agent-jet");
		expect(native.reload).not.toHaveBeenCalled();
	});

	test("on Android uses React Native's reload, since Expo's does nothing in Expo Go there", () => {
		const reloadAppAsync = mock(() => Promise.resolve());
		runtime.expo = { reloadAppAsync };
		native.os = "android";
		reloadBundle();
		expect(reloadAppAsync).not.toHaveBeenCalled();
		expect(native.reload).toHaveBeenCalledTimes(1);
	});

	test("without Expo, React Native's reload is the only option", () => {
		reloadBundle();
		expect(native.reload).toHaveBeenCalledTimes(1);
	});

	test("an Expo runtime without reloadAppAsync still reloads", () => {
		runtime.expo = { modules: {} };
		reloadBundle();
		expect(native.reload).toHaveBeenCalledTimes(1);
	});
});
