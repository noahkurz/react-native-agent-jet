import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { DEFAULT_SCREENSHOT_SCALE, UNKNOWN_POINT_WIDTH_MAX_PX } from "../host/constants.js";
import { pngWidth, sizeScreenshot } from "../host/image.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GRAYSCALE = 0;
const RGB = 2;
const PALETTE = 3;
const CHANNELS: Record<number, number> = { [GRAYSCALE]: 1, [RGB]: 3 };

function pngHeaderOnly(width: number, height = 100): string {
	const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
	const path = join(dir, "shot.png");
	const ihdr = Buffer.alloc(25);
	SIGNATURE.copy(ihdr, 0);
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

function writePng(samples: Buffer, width: number, height: number, colorType: number): string {
	const dir = mkdtempSync(join(tmpdir(), "jet-png-real-"));
	const path = join(dir, "shot.png");

	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;

	const stride = width * CHANNELS[colorType];
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		samples.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	writeFileSync(
		path,
		Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
	);
	return path;
}

/** A real PNG with pixel data, so the resizer can actually resample it. */
function resizablePng(width: number, height = 40): string {
	const stride = width * 3;
	const samples = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) samples[y * stride + x * 3] = (x * 7) % 256;
	}
	return writePng(samples, width, height, RGB);
}

/** One row of greyscale samples, so a resample can be asserted sample by sample. */
function greyscaleRow(values: number[]): string {
	return writePng(Buffer.from(values), values.length, 1, GRAYSCALE);
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const fromLeft = Math.abs(estimate - left);
	const fromUp = Math.abs(estimate - up);
	const fromUpLeft = Math.abs(estimate - upLeft);
	if (fromLeft <= fromUp && fromLeft <= fromUpLeft) return left;
	return fromUp <= fromUpLeft ? up : upLeft;
}

/** Independent reader, so the tests check the bytes rather than trusting the encoder. */
function readPng(path: string): { width: number; height: number; samples: number[] } {
	const buffer = readFileSync(path);
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	const channels = CHANNELS[buffer.readUInt8(25)];

	const parts: Buffer[] = [];
	let offset = 8;
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") parts.push(buffer.subarray(offset + 8, offset + 8 + length));
		if (type === "IEND") break;
		offset += 12 + length;
	}

	const raw = inflateSync(Buffer.concat(parts));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const from = y * (stride + 1);
		const filter = raw[from];
		const to = y * stride;
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? pixels[to + i - channels] : 0;
			const up = y > 0 ? pixels[to - stride + i] : 0;
			const upLeft = y > 0 && i >= channels ? pixels[to - stride + i - channels] : 0;
			const predicted =
				filter === 0
					? 0
					: filter === 1
						? left
						: filter === 2
							? up
							: filter === 3
								? (left + up) >> 1
								: paeth(left, up, upLeft);
			pixels[to + i] = (raw[from + 1 + i] + predicted) & 0xff;
		}
	}

	return { width, height, samples: [...pixels] };
}

describe("pngWidth", () => {
	test("reads the width from the header with no external tools", async () => {
		expect(await pngWidth(pngHeaderOnly(1320))).toBe(1320);
	});

	test("rejects a file whose IHDR chunk declares the wrong length", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jet-png-"));
		const path = join(dir, "bad-length.png");
		const bytes = Buffer.alloc(64);
		SIGNATURE.copy(bytes, 0);
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

describe("resampling", () => {
	test("averages the samples each output pixel covers instead of dropping columns", async () => {
		// Nearest-neighbour would pick 0 and 200; the averages are 50 and 228.
		const path = greyscaleRow([0, 100, 200, 255]);
		await sizeScreenshot(path, { preferredPixelWidth: 2 });
		expect(readPng(path).samples).toEqual([50, 228]);
	});

	test("weights partly covered samples when the ratio is not a whole number", async () => {
		// 3 → 2 is a 1.5:1 box: the middle sample is split evenly between both outputs.
		const path = greyscaleRow([0, 150, 210]);
		await sizeScreenshot(path, { preferredPixelWidth: 2 });
		expect(readPng(path).samples).toEqual([50, 190]);
	});

	test("keeps the aspect ratio and writes a PNG that reads back at the new size", async () => {
		const path = resizablePng(1320, 40);
		const shot = await sizeScreenshot(path, { pointWidth: 440, scale: 1 });

		expect(shot.width).toBe(440);
		expect(await pngWidth(path)).toBe(440);
		expect(readPng(path).height).toBe(13); // round(40 × 440 / 1320)
	});

	test("resamples without an external tool on every platform", async () => {
		const path = resizablePng(1320);
		const shot = await sizeScreenshot(path, { preferredPixelWidth: 800 });
		expect(shot.width).toBe(800);
		expect(await pngWidth(path)).toBe(800);
	});

	test("leaves a PNG it cannot decode at its native size", async () => {
		const header = Buffer.alloc(13);
		header.writeUInt32BE(1320, 0);
		header.writeUInt32BE(100, 4);
		header[8] = 8;
		header[9] = PALETTE;

		const dir = mkdtempSync(join(tmpdir(), "jet-png-palette-"));
		const path = join(dir, "palette.png");
		writeFileSync(path, Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IEND", Buffer.alloc(0))]));

		const shot = await sizeScreenshot(path, { pointWidth: 440 });
		expect(shot.width).toBe(1320);
		expect(shot.inPoints).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("sizeScreenshot", () => {
	test("halves the point width by default", async () => {
		const shot = await sizeScreenshot(resizablePng(1320), { pointWidth: 440 });
		expect(shot.width).toBe(440 * DEFAULT_SCREENSHOT_SCALE);
		expect(shot.inPoints).toBe(false);
	});

	test("scale 1 means one pixel per point", async () => {
		const shot = await sizeScreenshot(resizablePng(1320), { pointWidth: 440, scale: 1 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("derives the point width from a fractional Android device scale", async () => {
		// 1080px at 2.625 is 411.43pt, so half of it rounds to 206.
		const shot = await sizeScreenshot(resizablePng(1080), { deviceScale: 2.625 });
		expect(shot.width).toBe(206);
		expect(shot.inPoints).toBe(false);
	});

	test("caps the width when no app is connected and the point size is unknown", async () => {
		const shot = await sizeScreenshot(resizablePng(1320));
		expect(shot.width).toBe(UNKNOWN_POINT_WIDTH_MAX_PX);
		expect(shot.inPoints).toBe(false);
	});

	test("never upscales a screen already narrower than the cap", async () => {
		const shot = await sizeScreenshot(resizablePng(320));
		expect(shot.width).toBe(320);
		expect(shot.inPoints).toBe(false);
	});

	test("falls back to the native image when the resize fails, without claiming points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(1080), { deviceScale: 2.625 });
		expect(shot.width).toBe(1080);
		expect(shot.inPoints).toBe(false);
	});

	test("a fractional point width still counts as points once rounded", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(411), { pointWidth: 411.4285714285714, scale: 1 });
		expect(shot.width).toBe(411);
		expect(shot.inPoints).toBe(true);
	});

	test("an explicit pixel width wins over the scaled point width, and is never reported as points", async () => {
		const shot = await sizeScreenshot(resizablePng(1320), { preferredPixelWidth: 800, pointWidth: 440 });
		expect(shot.width).toBe(800);
		expect(shot.inPoints).toBe(false);
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
		const shot = await sizeScreenshot(pngHeaderOnly(440), { pointWidth: 440, scale: 1 });
		expect(shot.width).toBe(440);
		expect(shot.inPoints).toBe(true);
	});

	test("a width wider than the image is not upscaled and is not claimed as points", async () => {
		const shot = await sizeScreenshot(pngHeaderOnly(400), { pointWidth: 800, scale: 1 });
		expect(shot.width).toBe(400);
		expect(shot.inPoints).toBe(false);
	});
});
