import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Button, Device, Point } from "./device.js";
import { screenshotDir } from "./ios.js";
import { downscaleIfPossible, pngWidth } from "./image.js";

const exec = promisify(execFile);

async function run(command: string, args: string[]): Promise<string> {
	const { stdout } = await exec(command, args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

let adbChecked: boolean | null = null;

export async function hasAdb(): Promise<boolean> {
	if (adbChecked !== null) return adbChecked;
	try {
		await run("adb", ["version"]);
		adbChecked = true;
	} catch {
		adbChecked = false;
	}
	return adbChecked;
}

export async function serial(): Promise<string> {
	if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
	if (!(await hasAdb()))
		throw new Error("adb is not on PATH. Install Android platform-tools or add $ANDROID_HOME/platform-tools to PATH.");
	const lines = (await run("adb", ["devices"])).split("\n").slice(1);
	const online = lines.map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === "device");
	if (!online?.[0]) throw new Error("No Android device or emulator is connected. Start one, then check `adb devices`.");
	return online[0];
}

async function adb(args: string[]): Promise<string> {
	return run("adb", ["-s", await serial(), ...args]);
}

async function shell(command: string): Promise<string> {
	return adb(["shell", command]);
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function name(): Promise<string | null> {
	try {
		const id = await serial();
		const model = (await shell("getprop ro.product.model")).trim();
		const release = (await shell("getprop ro.build.version.release")).trim();
		return `${model} (Android ${release}, ${id})`;
	} catch {
		return null;
	}
}

let cachedDensity: number | null = null;

export async function pixelRatio(): Promise<number> {
	if (cachedDensity) return cachedDensity;
	const output = await shell("wm density");
	const match = /density:\s*(\d+)/i.exec(output);
	cachedDensity = match ? Number(match[1]) / 160 : 1;
	return cachedDensity;
}

export function setPixelRatio(ratio: number | undefined) {
	if (ratio) cachedDensity = ratio;
}

async function toPixels(point: Point): Promise<Point> {
	const ratio = await pixelRatio();
	return { x: Math.round(point.x * ratio), y: Math.round(point.y * ratio) };
}

export async function screenshot(targetWidth: number | null): Promise<{ path: string; width: number }> {
	const path = join(await screenshotDir(), `android-${Date.now()}.png`);
	const { stdout } = await exec("adb", ["-s", await serial(), "exec-out", "screencap", "-p"], {
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
	await writeFile(path, stdout);
	const native = await pngWidth(path);
	const target = targetWidth ?? Math.round(native / (await pixelRatio()));
	const width = await downscaleIfPossible(path, native, target);
	return { path, width };
}

export async function tap(point: Point): Promise<void> {
	const px = await toPixels(point);
	await shell(`input tap ${px.x} ${px.y}`);
}

export async function typeText(text: string): Promise<void> {
	if (/[^\x20-\x7e]/.test(text)) {
		throw new Error("adb can only type ASCII text; use set_text for other characters");
	}
	await shell(`input text ${quote(text.replace(/ /g, "%s"))}`);
}

export async function swipe(from: Point, to: Point, durationSeconds: number): Promise<void> {
	const a = await toPixels(from);
	const b = await toPixels(to);
	await shell(`input swipe ${a.x} ${a.y} ${b.x} ${b.y} ${Math.round(durationSeconds * 1000)}`);
}

const KEYCODES: Record<string, number> = { return: 66, enter: 66, backspace: 67, tab: 61, space: 62, escape: 111 };

export async function pressKey(key: string | number): Promise<void> {
	const code = typeof key === "number" ? key : KEYCODES[key.toLowerCase()];
	if (code === undefined) {
		throw new Error(
			`Unknown key "${key}"; use one of ${Object.keys(KEYCODES).join(", ")} or an Android keycode number`,
		);
	}
	await shell(`input keyevent ${code}`);
}

const BUTTONS: Partial<Record<Button, number>> = { home: 3, back: 4, lock: 26, "side-button": 26, recents: 187 };

export async function pressButton(button: Button): Promise<void> {
	const code = BUTTONS[button];
	if (code === undefined)
		throw new Error(`Android has no "${button}" button; use one of ${Object.keys(BUTTONS).join(", ")}`);
	await shell(`input keyevent ${code}`);
}

export async function describeNativeUi(): Promise<string> {
	await shell("uiautomator dump /sdcard/agent-jet-ui.xml");
	return shell("cat /sdcard/agent-jet-ui.xml");
}

export async function openUrl(url: string): Promise<void> {
	await shell(`am start -a android.intent.action.VIEW -d ${quote(url)}`);
}

export async function launchApp(appId: string): Promise<void> {
	await shell(`monkey -p ${quote(appId)} -c android.intent.category.LAUNCHER 1`);
}

export async function terminateApp(appId: string): Promise<void> {
	await shell(`am force-stop ${quote(appId)}`);
}

export async function setAppearance(mode: "light" | "dark"): Promise<void> {
	await shell(`cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
}

export async function reversePort(port: number): Promise<void> {
	try {
		await adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
	} catch {}
}

export const android: Device = {
	platform: "android",
	name,
	hasInput: hasAdb,
	inputHint: "install Android platform-tools and put adb on PATH",
	screenshot,
	tap,
	typeText,
	swipe,
	pressKey,
	pressButton,
	describeNativeUi,
	openUrl,
	launchApp,
	terminateApp,
	setAppearance,
};
