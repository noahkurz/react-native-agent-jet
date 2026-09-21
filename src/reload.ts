import { DevSettings, Platform } from "react-native";

type ExpoRuntime = { reloadAppAsync?: (reason: string) => Promise<void> };

/**
 * Expo Go on iOS rebuilds its native modules only through Expo's own reload. React Native's
 * reload recreates the JS runtime without them, and the next bundle dies at the first Expo
 * module it touches — "Cannot find native module 'ExpoAsset'" before the app even starts.
 *
 * On Android it is the other way round: Expo's reload quietly does nothing unless the host
 * activity is a ReactActivity, which Expo Go's is not, while React Native's reload works.
 */
export function reloadBundle(): void {
	const expo = (globalThis as { expo?: ExpoRuntime }).expo;
	const expoReload = Platform.OS === "ios" ? expo?.reloadAppAsync : undefined;
	if (expoReload) void expoReload("Reloaded by react-native-agent-jet");
	else DevSettings.reload();
}
