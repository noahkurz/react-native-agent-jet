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

/** Pending timers this process is holding, so a leaked wait timer is visible. */
function activeTimerCount(): number {
	const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
	return handles.filter((handle) => handle?.constructor?.name === "Timeout").length;
}

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

describe("server startup", () => {
	test("listening resolves once the port is known", async () => {
		const app = await serve();
		expect(app.port).toBeGreaterThan(0);
	});

	test("listening rejects instead of hanging when the port is taken", async () => {
		const taken = await serve();

		const clash = new AppConnection(taken.port);
		servers.push(clash);

		await expect(clash.listening).rejects.toThrow(/in use|EADDRINUSE/i);
	});

	test("a caller that never awaits listening does not bring the process down", async () => {
		const taken = await serve();

		const ignored = new AppConnection(taken.port);
		servers.push(ignored);

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(ignored.port).toBe(taken.port);
	});
});

describe("waiting for a particular platform", () => {
	test("a waiter is not discarded when a different platform connects first", async () => {
		const app = await serve();

		const waitingForIos = app.ready(4_000, "ios");

		await fakeApp(app.port, "android");
		await until(() => app.all.length === 1, "android to register");

		await fakeApp(app.port, "ios");

		expect(await waitingForIos).toBe(true);
	});
});

describe("shutdown", () => {
	test("a wait in flight fails immediately instead of sitting out its timeout", async () => {
		const app = await serve();

		const waiting = app.ready(30_000, "ios");
		const startedAt = Date.now();

		await app.close();

		expect(await waiting).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	test("a wait started after shutdown fails without arming a timer", async () => {
		const app = await serve();
		await app.close();

		const startedAt = Date.now();
		expect(await app.ready(30_000, "ios")).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(100);
	});

	test("close leaves no timer holding the event loop open", async () => {
		const app = await serve();

		const waiting = app.ready(30_000, "ios");
		await app.close();
		await waiting;

		expect(activeTimerCount()).toBe(0);
	});
});

describe("a port it cannot bind", () => {
	async function serveOnTakenPort(): Promise<AppConnection> {
		const holder = await serve();
		const second = new AppConnection(holder.port);
		servers.push(second);
		await second.listening.catch(() => {});
		return second;
	}

	test("says the port is taken, names it, and points at both overrides", async () => {
		const blocked = await serveOnTakenPort();
		expect(blocked.listenFailure).toContain(`Port ${blocked.port} is already in use`);
		expect(blocked.listenFailure).toContain("AGENT_JET_PORT");
		expect(blocked.listenFailure).toContain("EXPO_PUBLIC_AGENT_JET_PORT");
	});

	test("a request fails at once, blaming the server rather than the app's setup", async () => {
		const blocked = await serveOnTakenPort();
		const failure = await blocked.request("ping", {}, undefined).catch((error: Error) => error.message);
		expect(failure).toContain("already in use");
		expect(failure).not.toContain("useAgentJet");
	});

	test("a call already waiting is told at once, not left until the timeout", async () => {
		const holder = await serve();
		const blocked = new AppConnection(holder.port);
		servers.push(blocked);

		const waitingBeforeTheFailureArrives = blocked
			.request("ping", {}, undefined)
			.catch((error: Error) => error.message);
		await expect(waitingBeforeTheFailureArrives).resolves.toContain("already in use");
	});

	test("a server that binds reports no failure", async () => {
		const app = await serve();
		expect(app.listenFailure).toBeNull();
	});
});
