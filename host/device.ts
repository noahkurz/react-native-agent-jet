export type Point = { x: number; y: number };

export type Platform = "ios" | "android";

export type Button = "home" | "back" | "lock" | "side-button" | "recents" | "siri" | "apple-pay";

export type Device = {
	platform: Platform;
	name(): Promise<string | null>;
	hasInput(): Promise<boolean>;
	inputHint: string;
	screenshot(targetWidth: number | null): Promise<{ path: string; width: number }>;
	tap(point: Point): Promise<void>;
	tapAccessible?(selector: { id?: string; label?: string }): Promise<void>;
	typeText(text: string): Promise<void>;
	swipe(from: Point, to: Point, durationSeconds: number): Promise<void>;
	pressKey(key: string | number): Promise<void>;
	pressButton(button: Button): Promise<void>;
	describeNativeUi(): Promise<string>;
	openUrl(url: string): Promise<void>;
	launchApp(appId: string): Promise<void>;
	terminateApp(appId: string): Promise<void>;
	setAppearance(mode: "light" | "dark"): Promise<void>;
};
