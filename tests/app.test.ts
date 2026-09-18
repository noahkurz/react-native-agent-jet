import { afterEach, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { AppConnection } from "../host/app.js";
import { HELLO } from "../src/protocol.js";

let port = 8900;
const nextPort = () => ++port;

const opened: WebSocket[] = [];
const servers: AppConnection[] = [];

/** Track the connection so afterEach can release its port. */
function serve(port: number): AppConnection {
	const app = new AppConnection(port);
	servers.push(app);
	return app;
}

afterEach(async () => {
	for (const socket of opened.splice(0)) socket.close();
	await Promise.all(servers.splice(0).map((app) => app.close()));
});

/** Connect a fake app that answers every request with `result`. */
function fakeApp(port: number, platform: "ios" | "android", result: unknown = { ok: true }): Promise<WebSocket> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		opened.push(socket);
		socket.on("open", () => {
			socket.send(
				JSON.stringify({
					type: HELLO,
					version: "test",
					device: {
						platform,
						windowWidth: 400,
						windowHeight: 800,
						screenWidth: 400,
						screenHeight: 800,
						pixelRatio: 2,
						fontScale: 1,
						appName: `${platform}-app`,
					},
				}),
			);
			resolve(socket);
		});
		socket.on("message", (raw) => {
			const { id } = JSON.parse(String(raw)) as { id: number };
			socket.send(JSON.stringify({ id, ok: true, result }));
		});
	});
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("binding", () => {
	test("listens on loopback only, so nothing on the network can reach it", async () => {
		const p = nextPort();
		serve(p);
		await settle();
		// loopback accepts
		await fakeApp(p, "ios");
		// a non-loopback interface does not
		const lan = Bun.spawnSync([
			"sh",
			"-c",
			`ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'`,
		]);
		const ip = lan.stdout.toString().trim();
		if (ip && ip !== "127.0.0.1") {
			const reachable = Bun.spawnSync(["nc", "-z", "-w", "1", ip, String(p)]).exitCode === 0;
			expect(reachable).toBe(false);
		}
	});
});

describe("connection registry", () => {
	test("registers an app once it says hello", async () => {
		const p = nextPort();
		const app = serve(p);
		expect(app.connected).toBe(false);
		await fakeApp(p, "ios");
		await settle();
		expect(app.connected).toBe(true);
		expect(app.device?.platform).toBe("ios");
	});

	test("keeps one connection per platform and holds both at once", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios");
		await fakeApp(p, "android");
		await settle();
		expect(app.all.map((a) => a.platform).sort()).toEqual(["android", "ios"]);
	});

	test("a second app on the same platform replaces the first", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios");
		await settle();
		await fakeApp(p, "ios");
		await settle();
		expect(app.all.filter((a) => a.platform === "ios")).toHaveLength(1);
	});
});

describe("platform routing", () => {
	test("routes a request to the requested platform", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", "from-ios");
		await fakeApp(p, "android", "from-android");
		await settle();
		expect(await app.request("ping", {}, "ios")).toBe("from-ios" as never);
		expect(await app.request("ping", {}, "android")).toBe("from-android" as never);
	});

	test("naming an unconnected platform fails with that platform in the message", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios");
		await settle();
		await expect(app.request("ping", {}, "android")).rejects.toThrow(/No android app connected/);
	}, 15_000);
});

describe("select_platform is honoured strictly", () => {
	test("does not silently fall back to the other platform", async () => {
		// regression: `active` fell through to the most recent connection, so selecting a
		// platform that was not connected quietly drove the other device instead.
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", "from-ios");
		await settle();
		app.preferred = "android";
		expect(app.connected).toBe(false);
		await expect(app.request("ping", {})).rejects.toThrow(/No android app connected/);
	}, 15_000);

	test("uses the preferred platform when it is connected", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", "from-ios");
		await fakeApp(p, "android", "from-android");
		await settle();
		app.preferred = "ios";
		expect(await app.request("ping", {})).toBe("from-ios" as never);
	});
});
