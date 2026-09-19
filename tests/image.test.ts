import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
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

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A real PNG with pixel data, so a resizer can actually resample it. */
function resizablePng(width: number, height = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "jet-png-real-"));
	const path = join(dir, "shot.png");

	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;

	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let row = 0; row < height; row++) {
		const start = row * (stride + 1);
		raw[start] = 0;
		for (let x = 0; x < width; x++) raw[start + 1 + x * 3] = (x * 7) % 256;
	}

	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(raw)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
	return path;
}

const canResample = (() => {
	try {
		execFileSync("sips", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("pngWidth", () => {
	test("reads the width from the header with no external tools", async () => {
		expect(await pngWidth(pngHeaderOnly(1320))).toBe(1320);
	});

	test("rejects a file whose IHDR chunk declares the wrong length", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
		const path = join(dir, "bad-length.png");
		const bytes = Buffer.alloc(64);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
		bytes.writeUInt32BE(25, 8);
		bytes.write("IHDR", 12, "ascii");
		bytes.writeUInt32BE(1320, 16);
		writeFileSync(path, bytes);
		await expect(pngWidth(path)).rejects.toThrow(/Not a PNG/);
		rmSync(dir, { recursive: true, force: true });
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

	test.skipIf(!canResample)(
		"an explicit pixel width wins over the point width, and is never reported as points",
		async () => {
			const shot = await sizeScreenshot(resizablePng(1320), { preferredPixelWidth: 800, pointWidth: 440 });
			expect(shot.width).toBe(800);
			expect(shot.inPoints).toBe(false);
		},
	);

	test.skipIf(!canResample)("a point width is resized to and reported as points", async () => {
		const shot = await sizeScreenshot(resizablePng(1320), { pointWidth: 440 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("an unresizable image keeps its native width and is not claimed as points", async () => {
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
