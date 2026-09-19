import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngWidth, sizeScreenshot } from "../host/image.js";

function pngHeaderOnly(width: number, height = 100): string {
	const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
	const path = join(dir, "shot.png");
	const ihdr = Buffer.alloc(25);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
	ihdr.writeUInt32BE(13, 8);
	ihdr.write("IHDR", 12, "ascii");
	ihdr.writeUInt32BE(width, 16);
	ihdr.writeUInt32BE(height, 20);
	writeFileSync(path, ihdr);
	return path;
}

describe("pngWidth", () => {
	test("reads the width from the header with no external tools", async () => {
		expect(await pngWidth(pngHeaderOnly(1320))).toBe(1320);
	});

	test("rejects a long file that forges the IHDR marker without the png signature", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
		const path = join(dir, "forged.png");
		const forged = Buffer.alloc(64);
		forged.write("IHDR", 12, "ascii");
		forged.writeUInt32BE(1320, 16);
		writeFileSync(path, forged);
		await expect(pngWidth(path)).rejects.toThrow(/Not a PNG/);
		await expect(sizeScreenshot(path, { pointWidth: 440 })).rejects.toThrow(/Not a PNG/);
		rmSync(dir, { recursive: true, force: true });
	});

	test("rejects a file that is not a png rather than returning nonsense", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
		const path = join(dir, "not.png");
		writeFileSync(path, "hello");
		await expect(pngWidth(path)).rejects.toThrow(/Not a PNG/);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("sizeScreenshot", () => {
	test("reports native pixels when neither a width nor a device scale is known", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(1320));
		expect(shot.width).toBe(1320);
		expect(shot.inPoints).toBe(false);
	});

	test("falls back to the native image when the resize fails, without claiming points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(1080), { deviceScale: 2.625 });
		expect(shot.width).toBe(1080);
		expect(shot.inPoints).toBe(false);
	});

	test("a fractional point width still counts as points once rounded", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(411), { pointWidth: 411.4285714285714 });
		expect(shot.width).toBe(411);
		expect(shot.inPoints).toBe(true);
	});

	test("an explicit pixel width is honoured but is never reported as points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(1320), { preferredPixelWidth: 800, pointWidth: 440 });
		expect(shot.width).toBe(1320);
		expect(shot.inPoints).toBe(false);
	});

	test("a pixel width that happens to equal the point width is still points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(440), { preferredPixelWidth: 440, pointWidth: 440 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("a point width the image already matches needs no resize and stays points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(440), { pointWidth: 440 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("a width wider than the image is not upscaled and is not claimed as points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(400), { pointWidth: 800 });
		expect(shot.width).toBe(400);
		expect(shot.inPoints).toBe(false);
	});
});
