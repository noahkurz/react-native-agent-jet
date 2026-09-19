import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Read a PNG's pixel width from its IHDR header — no external tools, works on any OS. */
export async function pngWidth(path: string): Promise<number> {
	const buffer = await readFile(path);
	// PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) → width is the next 4 bytes, big-endian.
	if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") {
		throw new Error("Not a PNG or unexpected header");
	}
	return buffer.readUInt32BE(16);
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

/**
 * Downscale a PNG to `targetWidth` when a resizer is available (sips, macOS).
 * Elsewhere (Windows/Linux) the native image is kept — callers report the real width.
 * Returns the resulting pixel width.
 */
async function downscaleIfPossible(path: string, nativeWidth: number, targetWidth: number): Promise<number> {
	targetWidth = Math.round(targetWidth);
	if (targetWidth >= nativeWidth) return nativeWidth;
	if (!(await hasSips())) return nativeWidth;
	try {
		await exec("sips", ["--resampleWidth", String(targetWidth), path]);
		return targetWidth;
	} catch {
		// A screenshot at the wrong size is far more useful than no screenshot at all.
		return nativeWidth;
	}
}

export type Screenshot = {
	path: string;
	width: number;
	/** True when one image pixel equals one point, so coordinates can be used for taps directly. */
	inPoints: boolean;
};

export type SizeRequest = {
	/** Preferred output width in pixels. The image is never upscaled and stays native when no
	 *  resizer is available, so the result may be wider or narrower. Says nothing about points. */
	pixelWidth?: number | null;
	/** The screen's width in points, if known. Only this can make the result tap-safe. */
	pointWidth?: number | null;
	/** Device pixel ratio, used to derive the point width when it was not supplied. */
	deviceScale?: number;
};

/**
 * Resolve a captured PNG to its final width and say whether that width is in points.
 * A pixel override and a point width are different things: only the latter makes the image's
 * coordinates usable for taps, so they are kept apart rather than collapsed into one number.
 */
export async function sizeScreenshot(path: string, request: SizeRequest = {}): Promise<Screenshot> {
	const native = await pngWidth(path);
	const derived = request.deviceScale ? native / request.deviceScale : null;
	const pointWidth = request.pointWidth ?? derived;
	const roundedPoints = pointWidth === null ? null : Math.round(pointWidth);
	const target = request.pixelWidth ?? roundedPoints;
	if (target === null) return { path, width: native, inPoints: false };
	const width = await downscaleIfPossible(path, native, target);
	return { path, width, inPoints: roundedPoints !== null && width === roundedPoints };
}
