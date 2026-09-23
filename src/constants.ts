export const DEFAULT_PORT = 8765;

const HIGHEST_PORT = 65535;

export const PORT_ENV = "EXPO_PUBLIC_AGENT_JET_PORT";

export const ANDROID_EMULATOR_HOST = "10.0.2.2";

export const LOCALHOST = "localhost";

declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Spelled as a literal member expression because that is the form Expo's Babel transform
 * replaces with the value at build time; read dynamically, it would always come back empty.
 * The test that sets PORT_ENV and expects it here is what keeps the two spellings together.
 */
function portFromEnvironment(): string | undefined {
	return typeof process === "undefined" ? undefined : process.env.EXPO_PUBLIC_AGENT_JET_PORT;
}

/**
 * Expo inlines every EXPO_PUBLIC_* variable into the bundle, so `EXPO_PUBLIC_AGENT_JET_PORT=8766
 * expo start` moves the bridge off a port another app already holds without editing app source.
 * Where that variable does not exist the default stands.
 */
export function configuredPort(): number {
	const configured = Number(portFromEnvironment());
	const isAPort = Number.isInteger(configured) && configured > 0 && configured <= HIGHEST_PORT;
	return isAPort ? configured : DEFAULT_PORT;
}
