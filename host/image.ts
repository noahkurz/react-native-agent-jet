import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import type { Frame } from "../src/protocol.js";
import { DEFAULT_SCREENSHOT_SCALE, FULL_DETAIL_SCALE, UNKNOWN_POINT_WIDTH_MAX_PX } from "./constants.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;
const CHUNK_HEADER_BYTES = CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES;

/** The IHDR chunk always comes first: width, height, bit depth, colour type, then interlacing last. */
const IHDR_DATA_START = PNG_SIGNATURE.length + CHUNK_HEADER_BYTES;
const IHDR_DATA_LENGTH = 13;
const IHDR_DIMENSIONS_BYTES = 8;

/** Channels per pixel for the PNG colour types that carry one sample per channel. */
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Colour types whose last channel is alpha: greyscale+alpha and RGBA. */
const HAS_ALPHA = new Set([4, 6]);

const OPAQUE = 255;
const SUPPORTED_BIT_DEPTH = 8;
const NOT_INTERLACED = 0;

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;

type PixelFormat = {
	colorType: number;
	channels: number;
};

type Header = {
	width: number;
	height: number;
	/** Set only for the files we can decode: 8-bit, non-interlaced, not palette-indexed. */
	format: PixelFormat | null;
};

function readHeader(buffer: Buffer): Header {
	const startsWithSignature = buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
	const carriesTheDimensions = buffer.length >= IHDR_DATA_START + IHDR_DIMENSIONS_BYTES;
	const declaresAnIhdrChunk =
		carriesTheDimensions &&
		buffer.readUInt32BE(PNG_SIGNATURE.length) === IHDR_DATA_LENGTH &&
		buffer.toString("ascii", PNG_SIGNATURE.length + CHUNK_LENGTH_BYTES, IHDR_DATA_START) === "IHDR";
	if (!startsWithSignature || !declaresAnIhdrChunk) throw new Error("Not a PNG or unexpected header");

	const ihdr = buffer.subarray(IHDR_DATA_START, IHDR_DATA_START + IHDR_DATA_LENGTH);
	return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), format: readPixelFormat(ihdr) };
}

function readPixelFormat(ihdr: Buffer): PixelFormat | null {
	const isComplete = ihdr.length === IHDR_DATA_LENGTH;
	if (!isComplete) return null;

	const colorType = ihdr[9]!;
	const channels = CHANNELS_BY_COLOR_TYPE[colorType];
	const isOneBytePerSample = ihdr[8] === SUPPORTED_BIT_DEPTH;
	const isSequential = ihdr[12] === NOT_INTERLACED;
	if (!channels || !isOneBytePerSample || !isSequential) return null;

	return { colorType, channels };
}

function compressedPixels(buffer: Buffer): Buffer {
	const parts: Buffer[] = [];
	let offset = PNG_SIGNATURE.length;

	while (offset + CHUNK_HEADER_BYTES <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + CHUNK_LENGTH_BYTES, offset + CHUNK_HEADER_BYTES);
		const start = offset + CHUNK_HEADER_BYTES;
		const end = start + length;
		if (end > buffer.length) break;

		if (type === "IDAT") parts.push(buffer.subarray(start, end));
		if (type === "IEND") break;
		offset = end + CHUNK_CRC_BYTES;
	}

	if (!parts.length) throw new Error("PNG carries no pixel data");
	return Buffer.concat(parts);
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const fromLeft = Math.abs(estimate - left);
	const fromUp = Math.abs(estimate - up);
	const fromUpLeft = Math.abs(estimate - upLeft);
	if (fromLeft <= fromUp && fromLeft <= fromUpLeft) return left;
	return fromUp <= fromUpLeft ? up : upLeft;
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
	switch (filter) {
		case FILTER_NONE:
			return 0;
		case FILTER_SUB:
			return left;
		case FILTER_UP:
			return up;
		case FILTER_AVERAGE:
			return (left + up) >> 1;
		case FILTER_PAETH:
			return paeth(left, up, upLeft);
		default:
			throw new Error(`Unknown PNG filter ${filter}`);
	}
}

/** Reverses the per-scanline filters, leaving one byte per sample in row-major order. */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
	const stride = width * channels;
	const expected = (stride + 1) * height;
	if (raw.length < expected) throw new Error("PNG pixel data is truncated");

	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const from = y * (stride + 1);
		const filter = raw[from]!;
		const to = y * stride;
		const above = to - stride;

		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? pixels[to + i - channels]! : 0;
			const up = y > 0 ? pixels[above + i]! : 0;
			const upLeft = y > 0 && i >= channels ? pixels[above + i - channels]! : 0;
			pixels[to + i] = (raw[from + 1 + i]! + predict(filter, left, up, upLeft)) & 0xff;
		}
	}
	return pixels;
}

/**
 * Scales `source` — a region of the decoded image, in pixels — down to the target size,
 * averaging every source pixel a destination pixel covers, weighted by how much of it
 * falls inside. Device scales are rarely whole numbers — Android is usually 2.625 — so
 * dropping rows and columns would alias text into mush.
 *
 * Colour is averaged premultiplied by alpha, so a transparent pixel cannot drag its
 * neighbours towards whatever colour happens to sit underneath it.
 */
function resample(
	pixels: Buffer,
	imageWidth: number,
	format: PixelFormat,
	source: Frame,
	targetWidth: number,
	targetHeight: number,
): Buffer {
	const { channels } = format;
	const alphaChannel = HAS_ALPHA.has(format.colorType) ? channels - 1 : -1;
	const colourChannels = alphaChannel === -1 ? channels : channels - 1;

	const resized = Buffer.alloc(targetWidth * targetHeight * channels);
	const horizontalRatio = source.width / targetWidth;
	const verticalRatio = source.height / targetHeight;
	const lastRow = source.y + source.height - 1;
	const lastColumn = source.x + source.width - 1;
	const totals = new Float64Array(channels);

	for (let row = 0; row < targetHeight; row++) {
		const top = source.y + row * verticalRatio;
		const bottom = top + verticalRatio;
		const lastSourceRow = Math.min(Math.ceil(bottom) - 1, lastRow);

		for (let column = 0; column < targetWidth; column++) {
			const left = source.x + column * horizontalRatio;
			const right = left + horizontalRatio;
			const lastSourceColumn = Math.min(Math.ceil(right) - 1, lastColumn);

			totals.fill(0);
			let coverage = 0;
			let colourCoverage = 0;

			for (let y = Math.floor(top); y <= lastSourceRow; y++) {
				const rowWeight = Math.min(y + 1, bottom) - Math.max(y, top);
				if (rowWeight <= 0) continue;

				for (let x = Math.floor(left); x <= lastSourceColumn; x++) {
					const columnWeight = Math.min(x + 1, right) - Math.max(x, left);
					if (columnWeight <= 0) continue;

					const weight = rowWeight * columnWeight;
					const from = (y * imageWidth + x) * channels;
					const alpha = alphaChannel === -1 ? OPAQUE : pixels[from + alphaChannel]!;
					const colourWeight = (weight * alpha) / OPAQUE;

					for (let channel = 0; channel < colourChannels; channel++) {
						totals[channel]! += pixels[from + channel]! * colourWeight;
					}
					if (alphaChannel !== -1) totals[alphaChannel]! += alpha * weight;
					coverage += weight;
					colourCoverage += colourWeight;
				}
			}

			const to = (row * targetWidth + column) * channels;
			for (let channel = 0; channel < colourChannels; channel++) {
				resized[to + channel] = colourCoverage ? Math.round(totals[channel]! / colourCoverage) : 0;
			}
			if (alphaChannel !== -1) {
				resized[to + alphaChannel] = coverage ? Math.round(totals[alphaChannel]! / coverage) : 0;
			}
		}
	}
	return resized;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let byte = 0; byte < 256; byte++) {
		let value = byte;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
		table[byte] = value;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(CHUNK_LENGTH_BYTES);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(CHUNK_CRC_BYTES);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** Paeth filters every row; it costs nothing to write and compresses UI gradients well. */
function filterRows(pixels: Buffer, width: number, height: number, channels: number): Buffer {
	const stride = width * channels;
	const raw = Buffer.alloc((stride + 1) * height);

	for (let y = 0; y < height; y++) {
		const from = y * stride;
		const to = y * (stride + 1);
		raw[to] = FILTER_PAETH;

		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? pixels[from + i - channels]! : 0;
			const up = y > 0 ? pixels[from - stride + i]! : 0;
			const upLeft = y > 0 && i >= channels ? pixels[from - stride + i - channels]! : 0;
			raw[to + 1 + i] = (pixels[from + i]! - paeth(left, up, upLeft)) & 0xff;
		}
	}
	return raw;
}

function encodePng(pixels: Buffer, width: number, height: number, format: PixelFormat): Buffer {
	const header = Buffer.alloc(IHDR_DATA_LENGTH);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = SUPPORTED_BIT_DEPTH;
	header[9] = format.colorType;

	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(filterRows(pixels, width, height, format.channels))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Writes `source` — a region of the image, in pixels — back to the file at `targetWidth`,
 * and returns that width. Returns null for anything we cannot decode (a palette PNG, an
 * interlaced one, a truncated one) so the caller can fall back to the untouched capture
 * rather than failing the screenshot.
 */
async function writeResized(
	path: string,
	buffer: Buffer,
	header: Header,
	source: Frame,
	targetWidth: number,
): Promise<number | null> {
	const coversEverything = source.width === header.width && source.height === header.height;
	const alreadyRight = coversEverything && targetWidth === header.width;
	if (alreadyRight) return header.width;
	if (!header.format) return null;

	// Built beside the capture and swapped in, so a failure part way through leaves the
	// original readable rather than a truncated file the caller would go on to send.
	const partial = `${path}.partial`;
	try {
		const pixels = unfilter(inflateSync(compressedPixels(buffer)), header.width, header.height, header.format.channels);
		const targetHeight = Math.max(1, Math.round((source.height * targetWidth) / source.width));
		const resized = resample(pixels, header.width, header.format, source, targetWidth, targetHeight);
		await writeFile(partial, encodePng(resized, targetWidth, targetHeight, header.format));
		await rename(partial, path);
		return targetWidth;
	} catch {
		await rm(partial, { force: true, recursive: true }).catch(() => {});
		return null;
	}
}

/**
 * Halving only pays when `tree` can supply the text the pixels lose, so a whole screen
 * with the app connected is the only thing halved by default. A crop is shown at full
 * detail instead — but never for more pixels than the screenshot it replaces, or
 * cropping to a full-width element would quietly become the expensive option.
 */
function defaultScale(region: Frame, screen: Frame, appIsConnected: boolean): number {
	if (coversTheScreen(region, screen)) return appIsConnected ? DEFAULT_SCREENSHOT_SCALE : FULL_DETAIL_SCALE;

	const budget = screen.width * screen.height * DEFAULT_SCREENSHOT_SCALE ** 2;
	const atFullDetail = region.width * region.height;
	return atFullDetail <= budget ? FULL_DETAIL_SCALE : Math.sqrt(budget / atFullDetail);
}

/** A crop is always inside the screen, so matching its size means showing all of it. */
function coversTheScreen(region: Frame, screen: Frame): boolean {
	return region.width === screen.width && region.height === screen.height;
}

function wholeImage(header: Header): Frame {
	return { x: 0, y: 0, width: header.width, height: header.height };
}

/** The overlap of two rectangles, or null when they do not overlap at all. */
function intersect(one: Frame, other: Frame): Frame | null {
	const x = Math.max(one.x, other.x);
	const y = Math.max(one.y, other.y);
	const right = Math.min(one.x + one.width, other.x + other.width);
	const bottom = Math.min(one.y + one.height, other.y + other.height);
	if (right <= x || bottom <= y) return null;

	return { x, y, width: right - x, height: bottom - y };
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

/** Converts a region in points to the pixels it covers, kept inside the image. */
function toPixels(region: Frame, pixelsPerPoint: number, header: Header): Frame {
	const x = clamp(Math.round(region.x * pixelsPerPoint), 0, header.width - 1);
	const y = clamp(Math.round(region.y * pixelsPerPoint), 0, header.height - 1);

	return {
		x,
		y,
		width: clamp(Math.round(region.width * pixelsPerPoint), 1, header.width - x),
		height: clamp(Math.round(region.height * pixelsPerPoint), 1, header.height - y),
	};
}

export type Screenshot = {
	path: string;
	width: number;
	/** True when one image pixel is one point, so coordinates need no conversion. */
	inPoints: boolean;
	/** What the image shows, in screen points, or null when the point size is unknown. */
	region: Frame | null;
	/** True when the image shows less than the whole screen. */
	cropped: boolean;
};

export type SizeRequest = {
	preferredPixelWidth?: number | null;
	pointWidth?: number | null;
	/** Fraction of the region's point width to render at. See defaultScale for the default. */
	scale?: number | null;
	/** Region to keep, in points. Ignored when the screen's point size is unknown. */
	crop?: Frame | null;
	deviceScale?: number;
};

export async function sizeScreenshot(path: string, request: SizeRequest = {}): Promise<Screenshot> {
	const buffer = await readFile(path);
	const header = readHeader(buffer);

	// `pointWidth` is the app reporting its own window; `deviceScale` is the device's
	// density, which adb knows whether or not the app is running. So the app is connected
	// only when the first is set, even though the second can still place the screen.
	const appIsConnected = request.pointWidth != null;
	const fromScale = request.deviceScale ? header.width / request.deviceScale : null;
	const pointWidth = request.pointWidth ?? fromScale;
	if (pointWidth === null) return sizeWithoutPoints(path, buffer, header, request);

	const pixelsPerPoint = header.width / pointWidth;
	const screen: Frame = { x: 0, y: 0, width: pointWidth, height: header.height / pixelsPerPoint };
	const region = request.crop ? intersect(request.crop, screen) : screen;
	if (!region) throw new Error("The requested region is entirely off screen");

	const scale = request.scale ?? defaultScale(region, screen, appIsConnected);
	const source = toPixels(region, pixelsPerPoint, header);
	const requested = request.preferredPixelWidth ?? Math.round(region.width * scale);
	const width = await writeResized(path, buffer, header, source, clamp(requested, 1, source.width));

	// Neither the crop nor the resize happened if we could not decode, so describe the
	// untouched capture rather than a region the image does not actually show.
	if (width === null) {
		const inPoints = header.width === Math.round(screen.width);
		return { path, width: header.width, inPoints, region: screen, cropped: false };
	}

	return {
		path,
		width,
		inPoints: width === Math.round(region.width),
		region,
		cropped: !coversTheScreen(region, screen),
	};
}

/**
 * Neither the app nor the device placed the screen, so points are unknown and there is
 * nothing to scale or crop against. Cap the width generously instead: `tree` needs the
 * app too, so this is the case where the image is the only way to read the screen.
 * `scale` then means a fraction of the capture itself, so scale:1 still means full detail
 * as the tool promises.
 */
async function sizeWithoutPoints(
	path: string,
	buffer: Buffer,
	header: Header,
	request: SizeRequest,
): Promise<Screenshot> {
	const nativeFraction = request.scale == null ? null : Math.round(header.width * request.scale);
	const requested = request.preferredPixelWidth ?? nativeFraction ?? UNKNOWN_POINT_WIDTH_MAX_PX;
	const width = await writeResized(path, buffer, header, wholeImage(header), clamp(requested, 1, header.width));
	return { path, width: width ?? header.width, inPoints: false, region: null, cropped: false };
}
