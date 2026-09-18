/** Names and limits used only on the host side. */

export const PACKAGE_NAME = "react-native-agent-jet";

/** The name this MCP server is registered under in every client's config. */
export const SERVER_KEY = "jet";

export const ENV = {
	port: "AGENT_JET_PORT",
	host: "AGENT_JET_HOST",
	platform: "AGENT_JET_PLATFORM",
} as const;

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const LOOPBACK_HOST = "127.0.0.1";

export const SKILL_PATH = [".claude", "skills", "agent-jet", "SKILL.md"] as const;
export const PLAYBOOK_FILE = "CLAUDE.md";

export const REQUEST_TIMEOUT_MS = 15_000;
export const CONNECT_WAIT_MS = 6_000;
export const STATUS_WAIT_MS = 3_000;
export const POLL_INTERVAL_MS = 250;
export const FOCUS_SETTLE_MS = 400;
export const DEFAULT_WAIT_MS = 5_000;
export const DEFAULT_SWIPE_DISTANCE = 300;
export const DEFAULT_SWIPE_SECONDS = 0.3;
