import { android, hasAdb, setPixelRatio } from "./android.js";
import type { AppConnection } from "./app.js";
import type { Device, Platform } from "./device.js";
import { ios } from "./ios.js";

export async function deviceFor(app: AppConnection, want?: Platform): Promise<Device> {
	const platform = want ?? app.preferred ?? app.connectionFor()?.device.platform;
	if (platform === "android") {
		setPixelRatio(app.connectionFor("android")?.device.pixelRatio ?? app.device?.pixelRatio);
		return android;
	}
	if (platform === "ios") return ios;
	// Probing must not throw: a machine without Xcode should still fall through to Android.
	if (await ios.name().catch(() => null)) return ios;
	if ((await hasAdb()) && (await android.name().catch(() => null))) return android;
	throw new Error("No app connected and no iOS Simulator or Android device found.");
}
