export const DEFAULT_PORT = 8765;

const HIGHEST_PORT = 65535;

export const PORT_ENV = "EXPO_PUBLIC_AGENT_JET_PORT";

export const ANDROID_EMULATOR_HOST = "10.0.2.2";

export const LOCALHOST = "localhost";

declare const process: { env: Record<string, string | undefined> } | undefined;

function portInlinedByExpoAtBuildTime(): string | undefined {
	return typeof process === "undefined" ? undefined : process.env.EXPO_PUBLIC_AGENT_JET_PORT;
}

export function configuredPort(): number {
	const configured = Number(portInlinedByExpoAtBuildTime());
	const isAPort = Number.isInteger(configured) && configured > 0 && configured <= HIGHEST_PORT;
	return isAPort ? configured : DEFAULT_PORT;
}
