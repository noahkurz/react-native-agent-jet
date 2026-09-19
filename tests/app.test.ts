import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
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
function fakeApp(
	port: number,
	platform: "ios" | "android",
	result: unknown = { ok: true },
	appName = `${platform}-app`,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		opened.push(socket);
		// without this a failed connection is an unhandled error that kills the test worker
		socket.on("error", reject);
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
						appName,
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

/** Wait for the registry to reach an expected state instead of sleeping a fixed amount. */
async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The first routable IPv4 address of this machine, or null when it only has loopback. */
function lanAddress(): string | null {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return null;
}

/** Whether a TCP connection to host:port is accepted within the timeout. */
function accepts(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const settle = (reachable: boolean) => {
			socket.destroy();
			resolve(reachable);
		};
		socket.setTimeout(timeoutMs);
		socket.on("connect", () => settle(true));
		socket.on("timeout", () => settle(false));
		socket.on("error", () => settle(false));
	});
}

const lan = lanAddress();

describe("binding", () => {
	test("accepts connections on loopback", async () => {
		const p = nextPort();
		serve(p);
		await fakeApp(p, "ios");
		expect(await accepts("127.0.0.1", p)).toBe(true);
	});

	test.skipIf(lan === null)("refuses connections arriving on a routable interface", async () => {
		const p = nextPort();
		serve(p);
		await fakeApp(p, "ios");
		expect(await accepts(lan!, p)).toBe(false);
	});
});

describe("connection registry", () => {
	test("registers an app once it says hello", async () => {
		const p = nextPort();
		const app = serve(p);
		expect(app.connected).toBe(false);
		await fakeApp(p, "ios");
		await until(() => app.connected, "the app to register");
		expect(app.connected).toBe(true);
		expect(app.device?.platform).toBe("ios");
	});

	test("keeps one connection per platform and holds both at once", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios");
		await fakeApp(p, "android");
		await until(() => app.all.length === 2, "both platforms to register");
		expect(app.all.map((a) => a.platform).sort()).toEqual(["android", "ios"]);
	});

	test("a second app on the same platform replaces the first", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", { ok: true }, "first-launch");
		await until(() => app.all[0]?.appName === "first-launch", "the first app to register");
		await fakeApp(p, "ios", { ok: true }, "second-launch");
		await until(() => app.all[0]?.appName === "second-launch", "the replacement to register");
		expect(app.all).toHaveLength(1);
		expect(app.connected).toBe(true);
	});
});

describe("platform routing", () => {
	test("routes a request to the requested platform", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", "from-ios");
		await fakeApp(p, "android", "from-android");
		await until(() => app.all.length === 2, "both platforms to register");
		expect(await app.request("ping", {}, "ios")).toBe("from-ios" as never);
		expect(await app.request("ping", {}, "android")).toBe("from-android" as never);
	});

	test("naming an unconnected platform fails with that platform in the message", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios");
		await until(() => app.connected, "the ios app to register");
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
		await until(() => app.connected, "the ios app to register");
		app.preferred = "android";
		expect(app.connected).toBe(false);
		await expect(app.request("ping", {})).rejects.toThrow(/No android app connected/);
	}, 15_000);

	test("uses the preferred platform when it is connected", async () => {
		const p = nextPort();
		const app = serve(p);
		await fakeApp(p, "ios", "from-ios");
		await fakeApp(p, "android", "from-android");
		await until(() => app.all.length === 2, "both platforms to register");
		app.preferred = "ios";
		expect(await app.request("ping", {})).toBe("from-ios" as never);
	});
});
