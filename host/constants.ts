export const PACKAGE_NAME = "react-native-agent-jet";

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
export const CLOSE_TIMEOUT_MS = 500;
export const POLL_INTERVAL_MS = 250;
export const FOCUS_SETTLE_MS = 400;
export const DEFAULT_WAIT_MS = 5_000;
export const DEFAULT_SWIPE_DISTANCE = 300;
export const DEFAULT_SWIPE_SECONDS = 0.3;

/**
 * Screenshots cost tokens by area, not by file size, so half the point width is a
 * quarter of the tokens. Text on screen comes from `tree`, which leaves the image to
 * show layout — spacing, overlap, clipping, colour — and half scale shows all of that.
 */
export const DEFAULT_SCREENSHOT_SCALE = 0.5;

/** One image pixel per point: the whole screen costs ~4× the default, but text is legible. */
export const FULL_DETAIL_SCALE = 1;

/** Context kept around a cropped element, in points, so its spacing stays visible. */
export const CROP_MARGIN_POINTS = 12;

/** Fallback width when no app is connected and the screen's point size is unknown. */
export const UNKNOWN_POINT_WIDTH_MAX_PX = 450;

export const SHUTDOWN_MESSAGE = "The agent-jet server is shutting down.";
