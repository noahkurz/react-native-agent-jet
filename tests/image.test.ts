import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngWidth, sizeScreenshot } from "../host/image.js";

/** A minimal but structurally valid PNG header of the given size. */
function png(width: number, height = 100): string {
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
		expect(await pngWidth(png(1320))).toBe(1320);
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
		// regression: it used to guess a retina factor, then claim the result was in points
		const shot = await sizeScreenshot(png(1320));
		expect(shot.width).toBe(1320);
		expect(shot.inPoints).toBe(false);
	});

	test("falls back to the native image when the resize fails, without claiming points", async () => {
		// the stub png has a header but no pixel data, so the resizer cannot process it
		const shot = await sizeScreenshot(png(1080), { deviceScale: 2.625 });
		expect(shot.width).toBe(1080);
		expect(shot.inPoints).toBe(false);
	});

	test("a fractional point width still counts as points once rounded", async () => {
		// regression: Android reports windowWidth as 411.428…, so an exact equality check
		// against the resized pixel width wrongly reported the image as native pixels.
		const shot = await sizeScreenshot(png(411), { pointWidth: 411.4285714285714 });
		expect(shot.width).toBe(411);
		expect(shot.inPoints).toBe(true);
	});

	test("an explicit pixel width is honoured but is never reported as points", async () => {
		// regression: the screenshot tool passed an explicit `width` override through the same
		// argument as the app's point width, so the result claimed 1px = 1pt and taps would miss.
		const shot = await sizeScreenshot(png(1320), { pixelWidth: 800, pointWidth: 440 });
		expect(shot.width).toBe(1320); // the stub cannot be resized, so it stays native
		expect(shot.inPoints).toBe(false);
	});

	test("a pixel width that happens to equal the point width is still points", async () => {
		const shot = await sizeScreenshot(png(440), { pixelWidth: 440, pointWidth: 440 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("a point width the image already matches needs no resize and stays points", async () => {
		const shot = await sizeScreenshot(png(440), { pointWidth: 440 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("a width wider than the image is not upscaled and is not claimed as points", async () => {
		const shot = await sizeScreenshot(png(400), { pointWidth: 800 });
		expect(shot.width).toBe(400);
		expect(shot.inPoints).toBe(false);
	});
});
