import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Put a fake `adb` on PATH that records the argv it was called with, so we can assert the exact
 * command sent to the device — including how untrusted strings are quoted.
 */
const bin = mkdtempSync(join(tmpdir(), "jet-adb-"));
const log = join(bin, "calls.txt");
const originalPath = process.env.PATH ?? "";

beforeAll(() => {
	writeFileSync(
		join(bin, "adb"),
		`#!/bin/sh
printf '%s\\n' "$*" >> ${log}
case "$*" in
  *devices*) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *"wm density"*) printf 'Physical density: 420\\n' ;;
  *version*) printf 'Android Debug Bridge version 1.0.41\\n' ;;
esac
exit 0
`,
	);
	chmodSync(join(bin, "adb"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
});

afterAll(() => {
	process.env.PATH = originalPath;
	rmSync(bin, { recursive: true, force: true });
});

const lastCall = () => {
	const lines = readFileSync(log, "utf8").trim().split("\n");
	return lines[lines.length - 1] ?? "";
};

describe("android device control", () => {
	test("taps are converted from points to device pixels", async () => {
		const { tap } = await import("../host/android.js");
		await tap({ x: 100, y: 200 }); // density 420 => scale 2.625
		expect(lastCall()).toBe("-s emulator-5554 shell input tap 263 525");
	});

	test("swipe passes both points and a duration in milliseconds", async () => {
		const { swipe } = await import("../host/android.js");
		await swipe({ x: 10, y: 20 }, { x: 30, y: 40 }, 0.3);
		expect(lastCall()).toMatch(/shell input swipe 26 53 79 105 300$/);
	});

	test("key names map to Android keycodes", async () => {
		const { pressKey } = await import("../host/android.js");
		await pressKey("return");
		expect(lastCall()).toMatch(/input keyevent 66$/);
	});

	test("an unknown key is rejected rather than sent to the device", async () => {
		const { pressKey } = await import("../host/android.js");
		await expect(pressKey("banana")).rejects.toThrow(/Unknown key/);
	});

	test("an unsupported hardware button is rejected", async () => {
		const { pressButton } = await import("../host/android.js");
		await expect(pressButton("siri")).rejects.toThrow(/no "siri" button/);
	});
});

describe("android shell quoting", () => {
	test("a url containing shell metacharacters is quoted, not interpreted", async () => {
		const { openUrl } = await import("../host/android.js");
		await openUrl("myapp://x?a=1;rm -rf /");
		const call = lastCall();
		expect(call).toContain("'myapp://x?a=1;rm -rf /'");
		expect(call).not.toMatch(/-d myapp:\/\/x\?a=1;rm/);
	});

	test("an embedded single quote cannot break out of the quoting", async () => {
		const { terminateApp } = await import("../host/android.js");
		await terminateApp("com.evil'; rm -rf /; echo '");
		expect(lastCall()).toContain(`'com.evil'\\''; rm -rf /; echo '\\'''`);
	});

	test("typed text is quoted and spaces are escaped for `input text`", async () => {
		const { typeText } = await import("../host/android.js");
		await typeText("hello world");
		expect(lastCall()).toBe("-s emulator-5554 shell input text 'hello%sworld'");
	});

	test("non-ascii text is rejected instead of being mangled by adb", async () => {
		const { typeText } = await import("../host/android.js");
		await expect(typeText("héllo")).rejects.toThrow(/ASCII/);
	});
});
