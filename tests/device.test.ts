import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "jet-adb-"));
const log = join(bin, "calls.txt");
const originalPath = process.env.PATH ?? "";

const FAKE_DENSITY_DPI = 420;
const BASELINE_DENSITY_DPI = 160;
const FAKE_DEVICE_SCALE = FAKE_DENSITY_DPI / BASELINE_DENSITY_DPI;
const inDevicePixels = (points: number) => Math.round(points * FAKE_DEVICE_SCALE);

beforeAll(() => {
	writeFileSync(
		join(bin, "adb"),
		`#!/bin/sh
: > "${log}"
for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done
case "$*" in
  *devices*) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  *"wm density"*) printf 'Physical density: ${FAKE_DENSITY_DPI}\\n' ;;
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

const lastArgs = (): string[] => readFileSync(log, "utf8").trim().split("\n");

const lastShellCommand = (): string => lastArgs().at(-1) ?? "";

describe("android device control", () => {
	test("taps are converted from points to device pixels", async () => {
		const { tap } = await import("../host/android.js");
		await tap({ x: 100, y: 200 });
		expect(lastArgs()).toEqual([
			"-s",
			"emulator-5554",
			"shell",
			`input tap ${inDevicePixels(100)} ${inDevicePixels(200)}`,
		]);
	});

	test("swipe passes both points and a duration in milliseconds", async () => {
		const { swipe } = await import("../host/android.js");
		await swipe({ x: 10, y: 20 }, { x: 30, y: 40 }, 0.3);
		expect(lastShellCommand()).toBe(
			`input swipe ${inDevicePixels(10)} ${inDevicePixels(20)} ${inDevicePixels(30)} ${inDevicePixels(40)} 300`,
		);
	});

	test("key names map to Android keycodes", async () => {
		const { pressKey } = await import("../host/android.js");
		await pressKey("return");
		expect(lastShellCommand()).toBe("input keyevent 66");
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
		const marker = join(bin, "url-marker");
		await openUrl(`myapp://x?a=1; touch ${marker}`);
		expect(lastShellCommand()).toBe(`am start -a android.intent.action.VIEW -d 'myapp://x?a=1; touch ${marker}'`);
		expect(existsSync(marker)).toBe(false);
	});

	test("an embedded single quote cannot break out of the quoting", async () => {
		const { terminateApp } = await import("../host/android.js");
		const marker = join(bin, "quote-marker");
		await terminateApp(`com.evil'; touch ${marker}; echo '`);
		expect(lastShellCommand()).toBe(`am force-stop 'com.evil'\\''; touch ${marker}; echo '\\'''`);
		expect(existsSync(marker)).toBe(false);
	});

	test("typed text is quoted and spaces are escaped for `input text`", async () => {
		const { typeText } = await import("../host/android.js");
		await typeText("hello world");
		expect(lastShellCommand()).toBe("input text 'hello%sworld'");
	});

	test("non-ascii text is rejected instead of being mangled by adb", async () => {
		const { typeText } = await import("../host/android.js");
		await expect(typeText("héllo")).rejects.toThrow(/ASCII/);
	});
});

describe("which device a tool drives", () => {
	const noApp = { connectionFor: () => null, device: null, preferred: null } as never;

	const appWith = (connected: "ios" | "android", preferred: "ios" | "android" | null = null) =>
		({
			preferred,
			device: { platform: connected, pixelRatio: 2 },
			connectionFor: (platform?: string) => {
				if (platform && platform !== connected) return null;
				if (preferred && preferred !== connected) return null;
				return { device: { platform: connected, pixelRatio: 2 } };
			},
		}) as never;

	test("an explicit per-call platform wins over everything", async () => {
		const { deviceFor } = await import("../host/devices.js");
		expect((await deviceFor(appWith("ios", "ios"), "android")).platform).toBe("android");
	});

	test("select_platform wins over the connected app", async () => {
		const { deviceFor } = await import("../host/devices.js");
		expect((await deviceFor(appWith("ios", "android"))).platform).toBe("android");
	});

	test("the connected app is used when no platform was selected", async () => {
		const { deviceFor } = await import("../host/devices.js");
		expect((await deviceFor(appWith("android"))).platform).toBe("android");
	});

	test("falls back to Android when the iOS toolchain is absent", async () => {
		const { deviceFor } = await import("../host/devices.js");
		const pathWithoutXcrun = bin;
		const previous = process.env.PATH;
		process.env.PATH = pathWithoutXcrun;
		try {
			const device = await deviceFor(noApp);
			expect(device.platform).toBe("android");
		} finally {
			process.env.PATH = previous;
		}
	});
});

describe("device name never rejects", () => {
	const withPathOf = async (dir: string, body: () => Promise<void>) => {
		const previous = process.env.PATH;
		process.env.PATH = dir;
		try {
			await body();
		} finally {
			process.env.PATH = previous;
		}
	};

	test("ios reports null when xcrun is unavailable", async () => {
		const { bootedName } = await import("../host/ios.js");
		const empty = mkdtempSync(join(tmpdir(), "jet-empty-"));
		await withPathOf(empty, async () => {
			expect(await bootedName()).toBeNull();
		});
		rmSync(empty, { recursive: true, force: true });
	});

	test("android reports null when adb fails", async () => {
		const { name } = await import("../host/android.js");
		const broken = mkdtempSync(join(tmpdir(), "jet-broken-"));
		writeFileSync(join(broken, "adb"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(broken, "adb"), 0o755);
		await withPathOf(broken, async () => {
			expect(await name()).toBeNull();
		});
		rmSync(broken, { recursive: true, force: true });
	});
});
