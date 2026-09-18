import type { LogEntry, NetworkEntry } from "./protocol";
import { redactBody, redactText, redactUrl } from "./redact";

const LOG_LIMIT = 500;
const NETWORK_LIMIT = 200;
const BODY_LIMIT = 4000;

type CaptureShared = {
	installed: boolean;
	originalConsole: Console;
	logs: LogEntry[];
	network: NetworkEntry[];
	seq: number;
};

const shared: CaptureShared = ((
	globalThis as { __reactNativeAgentJetCapture?: CaptureShared }
).__reactNativeAgentJetCapture ??= {
	installed: false,
	originalConsole: { ...console },
	logs: [],
	network: [],
	seq: 0,
});

export const originalConsole = shared.originalConsole;
const { logs, network } = shared;
let insideFetch = 0;

function formatArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return arg.stack ?? arg.message;
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

function pushLog(entry: Omit<LogEntry, "seq" | "at">) {
	logs.push({ seq: ++shared.seq, at: Date.now(), ...entry, message: redactText(entry.message) });
	if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
}

function pushNetwork(entry: Omit<NetworkEntry, "seq" | "at">): NetworkEntry {
	const full = { seq: ++shared.seq, at: Date.now(), ...entry, url: redactUrl(entry.url) };
	network.push(full);
	if (network.length > NETWORK_LIMIT) network.splice(0, network.length - NETWORK_LIMIT);
	return full;
}

function truncate(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = typeof value === "string" ? value : formatArg(value);
	const text = redactBody(raw);
	return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…` : text;
}

type ErrorUtilsLike = {
	getGlobalHandler(): (error: Error, isFatal?: boolean) => void;
	setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
};

function installConsoleCapture() {
	const levels: Array<Exclude<LogEntry["level"], "uncaught">> = ["log", "info", "warn", "error", "debug"];
	for (const level of levels) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			pushLog({ level, message: args.map(formatArg).join(" ") });
			original(...args);
		};
	}
	const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
	if (errorUtils) {
		const previous = errorUtils.getGlobalHandler();
		errorUtils.setGlobalHandler((error, isFatal) => {
			pushLog({ level: "uncaught", message: `${isFatal ? "FATAL " : ""}${error.message}`, stack: error.stack });
			previous(error, isFatal);
		});
	}
}

type TrackedXhr = XMLHttpRequest & {
	__agentJet?: { method: string; url: string; startedAt: number; entry?: NetworkEntry };
};

function installNetworkCapture() {
	const proto = XMLHttpRequest.prototype;
	const open = proto.open;
	const send = proto.send;
	proto.open = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
		this.__agentJet = { method, url: String(url), startedAt: 0 };
		return (open as unknown as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
	} as typeof proto.open;
	proto.send = function (this: TrackedXhr, body?: Parameters<XMLHttpRequest["send"]>[0]) {
		const tracked = insideFetch > 0 ? undefined : this.__agentJet;
		if (tracked) {
			tracked.startedAt = Date.now();
			tracked.entry = pushNetwork({ method: tracked.method, url: tracked.url, requestBody: truncate(body) });
			this.addEventListener("loadend", () => {
				const entry = tracked.entry!;
				entry.status = this.status;
				entry.durationMs = Date.now() - tracked.startedAt;
				if (this.status === 0) entry.error = "network error or aborted";
				try {
					if (this.responseType === "" || this.responseType === "text")
						entry.responseBody = truncate(this.responseText);
				} catch {}
			});
		}
		return send.call(this, body);
	};
}

function installFetchCapture() {
	const original = globalThis.fetch;
	if (typeof original !== "function") return;
	globalThis.fetch = async function (
		this: unknown,
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) {
		const method = (
			init?.method ??
			(typeof input === "object" && input && "method" in input ? input.method : undefined) ??
			"GET"
		).toUpperCase();
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const entry = pushNetwork({ method, url, requestBody: truncate(init?.body ?? undefined) });
		const startedAt = Date.now();
		insideFetch++;
		let response: Response;
		try {
			response = await original.call(this, input as never, init as never);
		} catch (error) {
			entry.durationMs = Date.now() - startedAt;
			entry.error = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			insideFetch--;
		}
		entry.status = response.status;
		entry.durationMs = Date.now() - startedAt;
		try {
			entry.responseBody = truncate(await response.clone().text());
		} catch {}
		return response;
	} as typeof fetch;
}

export function installCapture() {
	if (shared.installed) return;
	shared.installed = true;
	installConsoleCapture();
	installNetworkCapture();
	installFetchCapture();
}

export function readLogs(since?: number, level?: LogEntry["level"]): LogEntry[] {
	return logs.filter(
		(entry) => (since === undefined || entry.seq > since) && (level === undefined || entry.level === level),
	);
}

export function readNetwork(since?: number): NetworkEntry[] {
	return network.filter((entry) => since === undefined || entry.seq > since);
}

export function clearCapture() {
	logs.length = 0;
	network.length = 0;
}
