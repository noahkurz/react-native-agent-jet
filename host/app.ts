import { WebSocketServer, type WebSocket } from "ws";
import {
	HELLO,
	type BridgeMethods,
	type DeviceInfo,
	type Hello,
	type MethodName,
	type Response,
} from "../src/protocol.js";
import type { Platform } from "./device.js";
import {
	CLOSE_TIMEOUT_MS,
	CONNECT_WAIT_MS,
	ENV,
	LOOPBACK_HOST,
	LOOPBACK_HOSTS,
	REQUEST_TIMEOUT_MS,
} from "./constants.js";

type Pending = {
	socket: WebSocket;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};

type Connection = { socket: WebSocket; device: DeviceInfo; version: string; connectedAt: number };

export class AppConnection {
	private connections: Connection[] = [];
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private waiters: Array<() => void> = [];
	preferred: Platform | null = (process.env[ENV.platform] as Platform | undefined) ?? null;

	private readonly server: WebSocketServer;

	constructor(readonly port: number) {
		const host = process.env[ENV.host] ?? LOOPBACK_HOST;
		const server = new WebSocketServer({ port, host });
		this.server = server;

		const reachableBeyondLoopback = !LOOPBACK_HOSTS.has(host);
		if (reachableBeyondLoopback) {
			process.stderr.write(
				`[agent-jet-mcp] WARNING: listening on ${host}, which is reachable from your network. ` +
					`There is no authentication, so anyone who can reach port ${port} can impersonate your app. ` +
					`Only do this on a trusted network.\n`,
			);
		}

		server.on("connection", (socket) => this.accept(socket));
		server.on("error", (error) => {
			process.stderr.write(`[agent-jet-mcp] websocket server error: ${error.message}\n`);
		});
	}

	close(): Promise<void> {
		this.connections.splice(0);
		for (const client of this.server.clients) client.terminate();

		return new Promise((resolve) => {
			const stopWaitingForStragglers = setTimeout(resolve, CLOSE_TIMEOUT_MS);
			this.server.close(() => {
				clearTimeout(stopWaitingForStragglers);
				resolve();
			});
		});
	}

	get active(): Connection | null {
		if (this.preferred) return this.connectionFor(this.preferred);
		return this.connections[this.connections.length - 1] ?? null;
	}

	get connected(): boolean {
		return this.active !== null;
	}

	get device(): DeviceInfo | null {
		return this.active?.device ?? null;
	}

	get version(): string | null {
		return this.active?.version ?? null;
	}

	get all(): Array<{ platform: string; appName?: string; version: string; active: boolean }> {
		const active = this.active;
		return this.connections.map((connection) => ({
			platform: connection.device.platform,
			appName: connection.device.appName,
			version: connection.version,
			active: connection === active,
		}));
	}

	private accept(socket: WebSocket) {
		socket.on("message", (data) => this.receive(socket, String(data)));

		socket.on("close", () => {
			this.connections = this.connections.filter((connection) => connection.socket !== socket);

			for (const [id, entry] of this.pending) {
				if (entry.socket !== socket) continue;
				clearTimeout(entry.timer);
				entry.reject(new Error("App disconnected"));
				this.pending.delete(id);
			}
		});
	}

	private receive(socket: WebSocket, raw: string) {
		let message: Response | Hello;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		if ("type" in message) {
			if (message.type === HELLO) {
				this.connections = this.connections.filter(
					(connection) => connection.socket !== socket && connection.device.platform !== message.device.platform,
				);
				this.connections.push({ socket, device: message.device, version: message.version, connectedAt: Date.now() });
				for (const wake of this.waiters.splice(0)) wake();
			}
			return;
		}

		const entry = this.pending.get(message.id);
		if (!entry) return;

		this.pending.delete(message.id);
		clearTimeout(entry.timer);

		if (message.ok) entry.resolve(message.result);
		else entry.reject(new Error(message.error));
	}

	connectionFor(platform?: Platform): Connection | null {
		if (platform) return this.connections.find((c) => c.device.platform === platform) ?? null;
		return this.active;
	}

	ready(timeoutMs = CONNECT_WAIT_MS, platform?: Platform): Promise<boolean> {
		return this.waitForConnection(platform, timeoutMs).then(
			() => true,
			() => false,
		);
	}

	private waitForConnection(platform?: Platform, timeoutMs = CONNECT_WAIT_MS): Promise<Connection> {
		const wanted = platform ?? this.preferred ?? undefined;
		const existing = this.connectionFor(wanted);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter !== wake);
				const want = wanted ? `${wanted} app` : "app";
				reject(
					new Error(
						`No ${want} connected on ws://localhost:${this.port}. Is it running in a dev build with useAgentJet() called?`,
					),
				);
			}, timeoutMs);
			const wake = () => {
				const match = this.connectionFor(wanted);
				if (!match) return;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((waiter) => waiter !== wake);
				resolve(match);
			};
			this.waiters.push(wake);
		});
	}

	async request<M extends MethodName>(
		method: M,
		params: BridgeMethods[M]["params"],
		platform?: Platform,
	): Promise<BridgeMethods[M]["result"]> {
		const { socket } = await this.waitForConnection(platform);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for the app to answer "${method}"`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { socket, resolve: resolve as (value: unknown) => void, reject, timer });
			socket.send(JSON.stringify({ id, method, params }));
		});
	}
}
