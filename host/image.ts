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
export async function downscaleIfPossible(path: string, nativeWidth: number, targetWidth: number): Promise<number> {
	targetWidth = Math.round(targetWidth);
	if (targetWidth >= nativeWidth) return nativeWidth;
	if (!(await hasSips())) return nativeWidth;
	await exec("sips", ["--resampleWidth", String(targetWidth), path]);
	return targetWidth;
}

/**
 * Resolve a captured PNG to its final width. `targetWidth` is what the caller wants (usually the
 * app's width in points). When it is unknown, the image is left at native resolution rather than
 * downscaled by a guessed scale factor.
 */
export async function sizeScreenshot(
	path: string,
	targetWidth: number | null,
	deviceScale?: number,
): Promise<{ path: string; width: number }> {
	const native = await pngWidth(path);
	const target = targetWidth ?? (deviceScale ? Math.round(native / deviceScale) : native);
	return { path, width: await downscaleIfPossible(path, native, target) };
}
