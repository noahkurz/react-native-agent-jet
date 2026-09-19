import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHUNK_LENGTH_BYTES = 4;
const IHDR_MARKER_START = PNG_SIGNATURE.length + CHUNK_LENGTH_BYTES;
const IHDR_MARKER_END = IHDR_MARKER_START + "IHDR".length;
const IHDR_WIDTH_OFFSET = IHDR_MARKER_END;
const IHDR_HEADER_LENGTH = IHDR_WIDTH_OFFSET + 4 + 4;

export async function pngWidth(path: string): Promise<number> {
	const buffer = await readFile(path);
	const startsWithSignature = buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
	const marker = buffer.toString("ascii", IHDR_MARKER_START, IHDR_MARKER_END);
	const isLongEnough = buffer.length >= IHDR_HEADER_LENGTH;
	const isPng = isLongEnough && startsWithSignature && marker === "IHDR";
	if (!isPng) throw new Error("Not a PNG or unexpected header");
	return buffer.readUInt32BE(IHDR_WIDTH_OFFSET);
}

let sipsChecked: boolean | null = null;

async function hasSips(): Promise<boolean> {
	if (sipsChecked !== null) return sipsChecked;
	try {
		await exec("sips", ["--version"]);
		sipsChecked = true;
	} catch {
		sipsChecked = false;
	}
	return sipsChecked;
}

async function downscaleIfPossible(path: string, nativeWidth: number, requestedWidth: number): Promise<number> {
	const targetWidth = Math.round(requestedWidth);
	const wouldUpscale = targetWidth >= nativeWidth;
	if (wouldUpscale) return nativeWidth;
	const canResize = await hasSips();
	if (!canResize) return nativeWidth;
	try {
		await exec("sips", ["--resampleWidth", String(targetWidth), path]);
		return targetWidth;
	} catch {
		return nativeWidth;
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
	deviceScale?: number;
};

export async function sizeScreenshot(path: string, request: SizeRequest = {}): Promise<Screenshot> {
	const native = await pngWidth(path);
	const fromScale = request.deviceScale ? native / request.deviceScale : null;
	const pointWidth = request.pointWidth ?? fromScale;
	const pointWidthInPixels = pointWidth === null ? null : Math.round(pointWidth);
	const requested = request.preferredPixelWidth ?? pointWidthInPixels;
	if (requested === null) return { path, width: native, inPoints: false };
	const width = await downscaleIfPossible(path, native, requested);
	return { path, width, inPoints: pointWidthInPixels !== null && width === pointWidthInPixels };
}
