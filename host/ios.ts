import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Button, Device, Point } from "./device.js";
import { sizeScreenshot, type Screenshot, type SizeRequest } from "./image.js";
import { PACKAGE_NAME } from "./constants.js";

const exec = promisify(execFile);

async function run(command: string, args: string[]): Promise<string> {
	const { stdout } = await exec(command, args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

async function bootedUdid(): Promise<string> {
	const raw = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
	const parsed = JSON.parse(raw) as { devices: Record<string, Array<{ udid: string; state: string; name: string }>> };
	for (const devices of Object.values(parsed.devices)) {
		const booted = devices.find((device) => device.state === "Booted");
		if (booted) return booted.udid;
	}
	throw new Error("No booted iOS Simulator. Boot one from Xcode or `xcrun simctl boot <name>`.");
}

export async function bootedName(): Promise<string | null> {
	try {
		const raw = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
		const parsed = JSON.parse(raw) as { devices: Record<string, Array<{ state: string; name: string }>> };
		for (const [runtime, devices] of Object.entries(parsed.devices)) {
			const booted = devices.find((device) => device.state === "Booted");
			if (booted) return `${booted.name} (${runtime.split(".").pop()})`;
		}
	} catch {}
	return null;
}

let axeChecked: boolean | null = null;

export async function hasAxe(): Promise<boolean> {
	if (axeChecked !== null) return axeChecked;
	try {
		await run("axe", ["--version"]);
		axeChecked = true;
	} catch {
		axeChecked = false;
	}
	return axeChecked;
}

async function axe(args: string[]): Promise<string> {
	if (!(await hasAxe())) {
		throw new Error(
			"AXe is not installed. Install with `brew install cameroncooke/axe/axe` to enable real touches and typing.",
		);
	}
	return run("axe", [...args, "--udid", await bootedUdid()]);
}

export async function screenshotDir(): Promise<string> {
	const dir = join(tmpdir(), PACKAGE_NAME);
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function screenshot(request: SizeRequest): Promise<Screenshot> {
	const path = join(await screenshotDir(), `screen-${Date.now()}.png`);
	await run("xcrun", ["simctl", "io", await bootedUdid(), "screenshot", path]);
	return sizeScreenshot(path, request);
}

export async function tap(point: Point): Promise<void> {
	await axe(["tap", "-x", String(point.x), "-y", String(point.y)]);
}

export async function tapAccessible(selector: { id?: string; label?: string }): Promise<void> {
	const args = selector.id ? ["--id", selector.id] : ["--label", selector.label ?? ""];
	await axe(["tap", ...args]);
}

export async function typeText(text: string): Promise<void> {
	await axe(["type", text]);
}

export async function swipe(from: Point, to: Point, durationSeconds: number): Promise<void> {
	await axe([
		"swipe",
		"--start-x",
		String(from.x),
		"--start-y",
		String(from.y),
		"--end-x",
		String(to.x),
		"--end-y",
		String(to.y),
		"--duration",
		String(durationSeconds),
	]);
}

const KEYCODES: Record<string, number> = { return: 40, enter: 40, backspace: 42, tab: 43, space: 44, escape: 41 };

export async function pressKey(key: string | number): Promise<void> {
	const code = typeof key === "number" ? key : KEYCODES[key.toLowerCase()];
	if (code === undefined)
		throw new Error(`Unknown key "${key}"; use one of ${Object.keys(KEYCODES).join(", ")} or a HID keycode number`);
	await axe(["key", String(code)]);
}

const BUTTONS: Partial<Record<Button, string>> = {
	home: "home",
	lock: "lock",
	"side-button": "side-button",
	siri: "siri",
	"apple-pay": "apple-pay",
};

export async function pressButton(button: Button): Promise<void> {
	const name = BUTTONS[button];
	if (!name)
		throw new Error(`The iOS Simulator has no "${button}" button; use one of ${Object.keys(BUTTONS).join(", ")}`);
	await axe(["button", name]);
}

export async function describeNativeUi(): Promise<string> {
	return axe(["describe-ui"]);
}

export async function openUrl(url: string): Promise<void> {
	await run("xcrun", ["simctl", "openurl", await bootedUdid(), url]);
}

export async function launchApp(bundleId: string): Promise<void> {
	await run("xcrun", ["simctl", "launch", await bootedUdid(), bundleId]);
}

export async function terminateApp(bundleId: string): Promise<void> {
	await run("xcrun", ["simctl", "terminate", await bootedUdid(), bundleId]);
}

export async function setAppearance(mode: "light" | "dark"): Promise<void> {
	await run("xcrun", ["simctl", "ui", await bootedUdid(), "appearance", mode]);
}

export const ios: Device = {
	platform: "ios",
	name: bootedName,
	hasInput: hasAxe,
	inputHint: "brew install cameroncooke/axe/axe",
	screenshot,
	tap,
	tapAccessible,
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
