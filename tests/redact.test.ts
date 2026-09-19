import { afterEach, describe, expect, test } from "bun:test";
import { configureRedaction, redactBody, redactText, redactUrl } from "../src/redact";

const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

afterEach(() => configureRedaction(true));

describe("default keys", () => {
	test("redacts a password but keeps the field and its siblings", () => {
		const out = parse(redactBody(JSON.stringify({ email: "a@b.com", password: "hunter2" })));
		expect(out).toEqual({ email: "a@b.com", password: "[redacted]" });
	});

	test("redacts every token flavour", () => {
		const out = parse(redactBody(JSON.stringify({ accessToken: "a", refreshToken: "b", expiresIn: 3600 })));
		expect(out).toEqual({ accessToken: "[redacted]", refreshToken: "[redacted]", expiresIn: 3600 });
	});

	test("reaches nested objects and arrays", () => {
		const out = redactBody(JSON.stringify({ users: [{ id: 1, apiKey: "sk-1" }] }));
		expect(out).toContain('"id":1');
		expect(out).not.toContain("sk-1");
	});

	test("does not touch fields that merely look sensitive", () => {
		const input = { author: "Noah", authored: true, tokenCountVisible: 1, title: "Hi" };
		const out = parse(redactBody(JSON.stringify(input)));
		expect(out.author).toBe("Noah");
		expect(out.authored).toBe(true);
	});

	test("leaves ordinary payloads byte-identical in content", () => {
		const posts = [{ userId: 1, id: 1, title: "qui est esse" }];
		expect(parse(`{"p":${redactBody(JSON.stringify(posts))}}`.replace('"p":', '"p":')).p).toEqual(posts);
	});
});

describe("free text", () => {
	test("redacts JWTs anywhere they appear", () => {
		const out = redactText("failed: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij done");
		expect(out).toBe("failed: [redacted jwt] done");
	});

	test("redacts Bearer/Basic/Token values but keeps the scheme", () => {
		expect(redactText("Authorization: Bearer sk_live_abcdef123456")).toBe("Authorization: Bearer [redacted]");
		expect(redactText("Basic YWxhZGRpbjpvcGVuc2VzYW1l")).toBe("Basic [redacted]");
	});

	test("leaves normal log lines alone", () => {
		const line = "params for /api/posts/for-you POST: {page: 0}";
		expect(redactText(line)).toBe(line);
	});
});

describe("urls and form bodies", () => {
	test("redacts sensitive query values and keeps the rest readable", () => {
		expect(redactUrl("https://api.example.com/me?access_token=secret&page=2")).toBe(
			"https://api.example.com/me?access_token=[redacted]&page=2",
		);
	});

	test("leaves a url with no secrets untouched", () => {
		const url = "https://jsonplaceholder.typicode.com/posts?_limit=20";
		expect(redactUrl(url)).toBe(url);
	});

	test("redacts a secret that is the FIRST form parameter", () => {
		expect(redactBody("password=hunter2&user=noah")).toBe("password=[redacted]&user=noah");
	});

	test("redacts a secret in the middle of a form body", () => {
		expect(redactBody("user=noah&password=hunter2&x=1")).toBe("user=noah&password=[redacted]&x=1");
	});
});

describe("custom keys", () => {
	test("camelCase and snake_case custom keys actually match", () => {
		configureRedaction({ keys: ["memberNumber", "policy_id"] });
		const out = parse(redactBody(JSON.stringify({ memberNumber: "M-1", policy_id: "P-1", title: "Hi" })));
		expect(out).toEqual({ memberNumber: "[redacted]", policy_id: "[redacted]", title: "Hi" });
	});

	test("matches regardless of separators or case in the payload", () => {
		configureRedaction({ keys: ["memberNumber"] });
		const out = parse(redactBody(JSON.stringify({ MEMBER_NUMBER: "a", "member-number": "b" })));
		expect(Object.values(out)).toEqual(["[redacted]", "[redacted]"]);
	});

	test("custom keys extend the defaults rather than replacing them", () => {
		configureRedaction({ keys: ["memberNumber"] });
		expect(redactBody(JSON.stringify({ password: "x" }))).toContain("[redacted]");
	});
});

describe("custom patterns", () => {
	test("catches a secret sitting under an innocuous field name", () => {
		configureRedaction({ patterns: [/sk_live_[A-Za-z0-9]+/] });
		expect(redactBody(JSON.stringify({ note: "key is sk_live_ABC123" }))).toBe('{"note":"key is [redacted]"}');
	});

	test("a non-global pattern still replaces every occurrence", () => {
		configureRedaction({ patterns: [/sk_live_\w+/] });
		expect(redactText("a sk_live_AAA and sk_live_BBB")).toBe("a [redacted] and [redacted]");
	});

	test("patterns apply inside urls too", () => {
		configureRedaction({ patterns: [/sk_live_\w+/] });
		expect(redactUrl("https://api.co/v1/sk_live_X?page=2")).toBe("https://api.co/v1/[redacted]?page=2");
	});
});

describe("opt out", () => {
	test("redact:false disables keys, patterns and free-text scrubbing", () => {
		configureRedaction(false);
		expect(redactBody(JSON.stringify({ password: "hunter2" }))).toContain("hunter2");
		expect(redactText("Bearer sk_live_abcdef123456")).toContain("sk_live_abcdef123456");
	});
});
