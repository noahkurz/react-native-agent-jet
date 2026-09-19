import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearCapture, installCapture, readLogs, readNetwork } from "../src/capture";
import { configureRedaction } from "../src/redact";

const ok = async () =>
	new Response(JSON.stringify({ token: "secret-value", items: [1, 2] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

let respondToFetch: (...args: Parameters<typeof fetch>) => Promise<Response> = ok;

beforeAll(() => {
	(globalThis as Record<string, unknown>).XMLHttpRequest ??= class {
		open() {}
		send() {}
		addEventListener() {}
	};
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => respondToFetch(...args)) as typeof fetch;
	installCapture();
});

beforeEach(() => {
	clearCapture();
	configureRedaction(true);
	respondToFetch = ok;
});

describe("console capture", () => {
	test("records level and message, newest last, with a monotonic seq", () => {
		console.log("first");
		console.warn("second");
		const entries = readLogs();
		expect(entries.map((e) => [e.level, e.message])).toEqual([
			["log", "first"],
			["warn", "second"],
		]);
		expect(entries[1]!.seq).toBeGreaterThan(entries[0]!.seq);
	});

	test("since returns only newer entries, so an agent can poll cheaply", () => {
		console.log("old");
		const seen = readLogs().at(-1)!.seq;
		console.log("new");
		expect(readLogs(seen).map((e) => e.message)).toEqual(["new"]);
	});

	test("level filters", () => {
		console.log("chatter");
		console.error("boom");
		expect(readLogs(undefined, "error").map((e) => e.message)).toEqual(["boom"]);
	});

	test("serialises non-string arguments", () => {
		console.log("payload", { a: 1 });
		expect(readLogs().at(-1)!.message).toBe('payload {"a":1}');
	});

	test("redacts secrets before they are ever stored", () => {
		console.log("Authorization: Bearer sk_live_abcdefghijk");
		expect(readLogs().at(-1)!.message).toBe("Authorization: Bearer [redacted]");
	});
});

describe("fetch capture", () => {
	test("records method, url, status and timing", async () => {
		await fetch("https://api.example.com/items");
		const [entry] = readNetwork();
		expect(entry).toMatchObject({ method: "GET", url: "https://api.example.com/items", status: 200 });
		expect(entry!.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("redacts secrets in the url and in both bodies", async () => {
		await fetch("https://api.example.com/login?access_token=abc123", {
			method: "POST",
			body: JSON.stringify({ email: "a@b.com", password: "hunter2" }),
		});
		const entry = readNetwork().at(-1)!;
		expect(entry.url).toBe("https://api.example.com/login?access_token=[redacted]");
		expect(entry.requestBody).toContain("[redacted]");
		expect(entry.requestBody).toContain("a@b.com");
		expect(entry.responseBody).not.toContain("secret-value");
	});

	test("the response is still readable by the app after capture clones it", async () => {
		const response = await fetch("https://api.example.com/items");
		expect(await response.json()).toMatchObject({ items: [1, 2] });
	});

	test("records a failed request with its reason rather than dropping it", async () => {
		respondToFetch = async () => {
			throw new Error("Unable to resolve host");
		};
		try {
			await expect(fetch("https://nope.example.com")).rejects.toThrow();
		} finally {
			respondToFetch = ok;
		}
		const entry = readNetwork().at(-1)!;
		expect(entry.status).toBeUndefined();
		expect(entry.error).toMatch(/Unable to resolve host/);
	});
});

describe("clearing", () => {
	test("clear empties both buffers", async () => {
		console.log("x");
		await fetch("https://api.example.com/items");
		clearCapture();
		expect(readLogs()).toHaveLength(0);
		expect(readNetwork()).toHaveLength(0);
	});
});
