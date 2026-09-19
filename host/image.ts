import { readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { DEFAULT_SCREENSHOT_SCALE, UNKNOWN_POINT_WIDTH_MAX_PX } from "./constants.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_LENGTH_BYTES = 4;
const CHUNK_TYPE_BYTES = 4;
const CHUNK_CRC_BYTES = 4;
const IHDR_DATA_LENGTH = 13;
const IHDR_MARKER_START = PNG_SIGNATURE.length + CHUNK_LENGTH_BYTES;
const IHDR_MARKER_END = IHDR_MARKER_START + "IHDR".length;
const IHDR_WIDTH_OFFSET = IHDR_MARKER_END;
const IHDR_HEADER_LENGTH = IHDR_WIDTH_OFFSET + 4 + 4;
const IHDR_BIT_DEPTH_OFFSET = IHDR_WIDTH_OFFSET + 8;
const IHDR_COLOR_TYPE_OFFSET = IHDR_BIT_DEPTH_OFFSET + 1;
const IHDR_INTERLACE_OFFSET = IHDR_BIT_DEPTH_OFFSET + 4;
const IHDR_DATA_END = IHDR_MARKER_END + IHDR_DATA_LENGTH;

/** Channels per pixel for the PNG colour types that carry one sample per channel. */
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

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
	const marker = buffer.toString("ascii", IHDR_MARKER_START, IHDR_MARKER_END);
	const isLongEnough = buffer.length >= IHDR_HEADER_LENGTH;
	const declaresAnIhdrChunk =
		isLongEnough && buffer.readUInt32BE(PNG_SIGNATURE.length) === IHDR_DATA_LENGTH && marker === "IHDR";
	const isPng = startsWithSignature && declaresAnIhdrChunk;
	if (!isPng) throw new Error("Not a PNG or unexpected header");

	return {
		width: buffer.readUInt32BE(IHDR_WIDTH_OFFSET),
		height: buffer.readUInt32BE(IHDR_WIDTH_OFFSET + 4),
		format: readPixelFormat(buffer),
	};
}

function readPixelFormat(buffer: Buffer): PixelFormat | null {
	const carriesTheWholeHeader = buffer.length >= IHDR_DATA_END;
	if (!carriesTheWholeHeader) return null;

	const colorType = buffer.readUInt8(IHDR_COLOR_TYPE_OFFSET);
	const channels = CHANNELS_BY_COLOR_TYPE[colorType];
	const isOneBytePerSample = buffer.readUInt8(IHDR_BIT_DEPTH_OFFSET) === SUPPORTED_BIT_DEPTH;
	const isSequential = buffer.readUInt8(IHDR_INTERLACE_OFFSET) === NOT_INTERLACED;
	if (!channels || !isOneBytePerSample || !isSequential) return null;

	return { colorType, channels };
}

export async function pngWidth(path: string): Promise<number> {
	return readHeader(await readFile(path)).width;
}

function compressedPixels(buffer: Buffer): Buffer {
	const parts: Buffer[] = [];
	let offset = PNG_SIGNATURE.length;

	while (offset + CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + CHUNK_LENGTH_BYTES, offset + CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES);
		const start = offset + CHUNK_LENGTH_BYTES + CHUNK_TYPE_BYTES;
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
 * Averages every source pixel a destination pixel covers, weighted by how much of it
 * falls inside. Device scales are rarely whole numbers — Android is usually 2.625 — so
 * dropping rows and columns would alias text into mush.
 */
function resample(
	pixels: Buffer,
	width: number,
	height: number,
	channels: number,
	targetWidth: number,
	targetHeight: number,
): Buffer {
	const resized = Buffer.alloc(targetWidth * targetHeight * channels);
	const horizontalRatio = width / targetWidth;
	const verticalRatio = height / targetHeight;
	const totals = new Float64Array(channels);

	for (let row = 0; row < targetHeight; row++) {
		const top = row * verticalRatio;
		const bottom = top + verticalRatio;
		const lastSourceRow = Math.min(Math.ceil(bottom) - 1, height - 1);

		for (let column = 0; column < targetWidth; column++) {
			const left = column * horizontalRatio;
			const right = left + horizontalRatio;
			const lastSourceColumn = Math.min(Math.ceil(right) - 1, width - 1);

			totals.fill(0);
			let coverage = 0;

			for (let y = Math.floor(top); y <= lastSourceRow; y++) {
				const rowWeight = Math.min(y + 1, bottom) - Math.max(y, top);
				if (rowWeight <= 0) continue;

				for (let x = Math.floor(left); x <= lastSourceColumn; x++) {
					const columnWeight = Math.min(x + 1, right) - Math.max(x, left);
					if (columnWeight <= 0) continue;

					const weight = rowWeight * columnWeight;
					const from = (y * width + x) * channels;
					for (let channel = 0; channel < channels; channel++) totals[channel]! += pixels[from + channel]! * weight;
					coverage += weight;
				}
			}

			const to = (row * targetWidth + column) * channels;
			for (let channel = 0; channel < channels; channel++) {
				resized[to + channel] = coverage ? Math.round(totals[channel]! / coverage) : 0;
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
 * Rewrites the file at a smaller width and returns the width it ended up with. Anything
 * we cannot decode — a palette PNG, an interlaced one, a truncated one — keeps its
 * native size rather than failing the screenshot.
 */
async function downscaleIfPossible(
	path: string,
	buffer: Buffer,
	header: Header,
	requestedWidth: number,
): Promise<number> {
	const targetWidth = Math.max(1, Math.round(requestedWidth));
	const wouldUpscale = targetWidth >= header.width;
	if (wouldUpscale || !header.format) return header.width;

	try {
		const { channels } = header.format;
		const pixels = unfilter(inflateSync(compressedPixels(buffer)), header.width, header.height, channels);
		const targetHeight = Math.max(1, Math.round((header.height * targetWidth) / header.width));
		const resized = resample(pixels, header.width, header.height, channels, targetWidth, targetHeight);
		await writeFile(path, encodePng(resized, targetWidth, targetHeight, header.format));
		return targetWidth;
	} catch {
		return header.width;
	}
}

export type Screenshot = {
	path: string;
	width: number;
	inPoints: boolean;
};

export type SizeRequest = {
	preferredPixelWidth?: number | null;
	pointWidth?: number | null;
	/** Fraction of the point width to render at. Defaults to DEFAULT_SCREENSHOT_SCALE. */
	scale?: number | null;
	deviceScale?: number;
};

export async function sizeScreenshot(path: string, request: SizeRequest = {}): Promise<Screenshot> {
	const buffer = await readFile(path);
	const header = readHeader(buffer);

	const fromScale = request.deviceScale ? header.width / request.deviceScale : null;
	const pointWidth = request.pointWidth ?? fromScale;
	const pointWidthInPixels = pointWidth === null ? null : Math.round(pointWidth);

	const scale = request.scale ?? DEFAULT_SCREENSHOT_SCALE;
	// With no app connected the screen's point size is unknown, so there is nothing to
	// scale; cap it instead, generously — that is the one case where the image is the
	// only way to read the screen, because `tree` needs the app too.
	const scaled = pointWidth === null ? UNKNOWN_POINT_WIDTH_MAX_PX : Math.round(pointWidth * scale);
	const requested = request.preferredPixelWidth ?? scaled;

	const width = await downscaleIfPossible(path, buffer, header, requested);

	return { path, width, inPoints: pointWidthInPixels !== null && width === pointWidthInPixels };
}
