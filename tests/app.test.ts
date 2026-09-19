import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { WebSocket } from "ws";
import { AppConnection } from "../host/app.js";
import { HELLO } from "../src/protocol.js";

const opened: WebSocket[] = [];
const servers: AppConnection[] = [];

async function serve(): Promise<AppConnection> {
	const app = new AppConnection(0);
	servers.push(app);
	await app.listening;
	return app;
}

afterEach(async () => {
	for (const socket of opened.splice(0)) socket.close();
	await Promise.all(servers.splice(0).map((app) => app.close()));
});

function fakeApp(
	port: number,
	platform: "ios" | "android",
	result: unknown = { ok: true },
	appName = `${platform}-app`,
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}`);
		opened.push(socket);
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

async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		const deadlineHasPassed = Date.now() > deadline;
		if (deadlineHasPassed) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function lanAddress(): string | null {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			const isRoutableIPv4 = address.family === "IPv4" && !address.internal;
			if (isRoutableIPv4) return address.address;
		}
	}
	return null;
}

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
		const app = await serve();
		await fakeApp(app.port, "ios");
		expect(await accepts("127.0.0.1", app.port)).toBe(true);
	});

	test.skipIf(lan === null)("refuses connections arriving on a routable interface", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios");
		expect(await accepts(lan!, app.port)).toBe(false);
	});
});

describe("connection registry", () => {
	test("registers an app once it says hello", async () => {
		const app = await serve();
		expect(app.connected).toBe(false);
		await fakeApp(app.port, "ios");
		await until(() => app.connected, "the app to register");
		expect(app.connected).toBe(true);
		expect(app.device?.platform).toBe("ios");
	});

	test("keeps one connection per platform and holds both at once", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios");
		await fakeApp(app.port, "android");
		await until(() => app.all.length === 2, "both platforms to register");
		expect(app.all.map((a) => a.platform).sort()).toEqual(["android", "ios"]);
	});

	test("a second app on the same platform replaces the first", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios", { ok: true }, "first-launch");
		await until(() => app.all[0]?.appName === "first-launch", "the first app to register");
		await fakeApp(app.port, "ios", { ok: true }, "second-launch");
		await until(() => app.all[0]?.appName === "second-launch", "the replacement to register");
		expect(app.all).toHaveLength(1);
		expect(app.connected).toBe(true);
	});
});

describe("platform routing", () => {
	test("routes a request to the requested platform", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios", "from-ios");
		await fakeApp(app.port, "android", "from-android");
		await until(() => app.all.length === 2, "both platforms to register");
		expect(await app.request("ping", {}, "ios")).toBe("from-ios" as never);
		expect(await app.request("ping", {}, "android")).toBe("from-android" as never);
	});

	test("naming an unconnected platform fails with that platform in the message", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios");
		await until(() => app.connected, "the ios app to register");
		await expect(app.request("ping", {}, "android")).rejects.toThrow(/No android app connected/);
	}, 15_000);
});

describe("select_platform is honoured strictly", () => {
	test("does not silently fall back to the other platform", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios", "from-ios");
		await until(() => app.connected, "the ios app to register");
		app.preferred = "android";
		expect(app.connected).toBe(false);
		await expect(app.request("ping", {})).rejects.toThrow(/No android app connected/);
	}, 15_000);

	test("uses the preferred platform when it is connected", async () => {
		const app = await serve();
		await fakeApp(app.port, "ios", "from-ios");
		await fakeApp(app.port, "android", "from-android");
		await until(() => app.all.length === 2, "both platforms to register");
		app.preferred = "ios";
		expect(await app.request("ping", {})).toBe("from-ios" as never);
	});
});
