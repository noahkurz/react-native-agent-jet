export type RedactOption = boolean | { keys?: string[] };

const DEFAULT_KEYS = [
	"password",
	"passwd",
	"secret",
	"token",
	"authorization",
	"apikey",
	"credential",
	"cookie",
	"sessionid",
	"privatekey",
	"ssn",
	"cardnumber",
	"cvv",
	"securitycode",
];

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

type Config = { enabled: boolean; keys: string[] };

const config: Config = { enabled: true, keys: DEFAULT_KEYS };

export function configureRedaction(option: RedactOption | undefined) {
	if (option === false) {
		config.enabled = false;
		return;
	}
	config.enabled = true;
	const extra = option && option !== true && option.keys ? option.keys.map(normalizeKey).filter(Boolean) : [];
	config.keys = extra.length ? [...DEFAULT_KEYS, ...extra] : DEFAULT_KEYS;
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return config.keys.some((needle) => normalized.includes(needle));
}

/** Scrub secrets that appear in free text: JWTs and `Bearer <token>` style values. */
export function redactText(text: string): string {
	if (!config.enabled) return text;
	return text.replace(JWT, "[redacted jwt]").replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
}

function redactStructured(value: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = isSensitiveKey(key) ? REDACTED : redactStructured(item, depth + 1);
		}
		return out;
	}
	if (typeof value === "string") return redactText(value);
	return value;
}

/** Redact a request/response body, keeping its shape and field names. */
export function redactBody(text: string): string {
	if (!config.enabled) return text;
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.stringify(redactStructured(JSON.parse(trimmed), 0));
		} catch {}
	}
	return redactText(text).replace(/(^|[?&])([^=&\s]+)=([^&\s]+)/g, (match, prefix: string, key: string) =>
		isSensitiveKey(key) ? `${prefix}${key}=${REDACTED}` : match,
	);
}

/** Redact sensitive query-string values while leaving the path readable. */
export function redactUrl(url: string): string {
	if (!config.enabled) return url;
	const split = url.indexOf("?");
	if (split === -1) return redactText(url);
	const path = url.slice(0, split);
	const query = url
		.slice(split + 1)
		.split("&")
		.map((pair) => {
			const eq = pair.indexOf("=");
			if (eq === -1) return pair;
			const key = pair.slice(0, eq);
			return isSensitiveKey(key) ? `${key}=${REDACTED}` : pair;
		})
		.join("&");
	return `${path}?${query}`;
}
