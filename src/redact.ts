export type RedactOption =
	| boolean
	| {
			keys?: string[];
			patterns?: RegExp[];
	  };

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

type Config = { enabled: boolean; keys: string[]; patterns: RegExp[] };

const config: Config = { enabled: true, keys: DEFAULT_KEYS, patterns: [] };

function globalize(pattern: RegExp): RegExp {
	return pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

export function configureRedaction(option: RedactOption | undefined) {
	if (option === false) {
		config.enabled = false;
		return;
	}
	config.enabled = true;
	const extra = option && option !== true && option.keys ? option.keys.map(normalizeKey).filter(Boolean) : [];
	config.keys = extra.length ? [...DEFAULT_KEYS, ...extra] : DEFAULT_KEYS;
	config.patterns = option && option !== true && option.patterns ? option.patterns.map(globalize) : [];
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return config.keys.some((needle) => normalized.includes(needle));
}

export function redactText(text: string): string {
	if (!config.enabled) return text;
	let out = text.replace(JWT, "[redacted jwt]").replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
	for (const pattern of config.patterns) out = out.replace(pattern, REDACTED);
	return out;
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

export function redactBody(text: string): string {
	if (!config.enabled) return text;
	const trimmed = text.trim();
	const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
	if (looksLikeJson) {
		try {
			return JSON.stringify(redactStructured(JSON.parse(trimmed), 0));
		} catch {}
	}

	return redactText(text).replace(/(^|[?&])([^=&\s]+)=([^&\s]+)/g, (match, prefix: string, key: string) =>
		isSensitiveKey(key) ? `${prefix}${key}=${REDACTED}` : match,
	);
}

export function redactUrl(url: string): string {
	if (!config.enabled) return url;
	const queryStart = url.indexOf("?");
	const hasQueryString = queryStart !== -1;
	if (!hasQueryString) return redactText(url);

	const path = url.slice(0, queryStart);
	const query = url
		.slice(queryStart + 1)
		.split("&")
		.map((pair) => {
			const separator = pair.indexOf("=");
			const isKeyValuePair = separator !== -1;
			if (!isKeyValuePair) return pair;
			const key = pair.slice(0, separator);
			return isSensitiveKey(key) ? `${key}=${REDACTED}` : pair;
		})
		.join("&");

	return redactText(`${path}?${query}`);
}
