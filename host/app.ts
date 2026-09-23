import { WebSocketServer, type WebSocket } from "ws";
import {
	HELLO,
	type BridgeMethods,
	type DeviceInfo,
	type Hello,
	type MethodName,
	type Response,
} from "../src/protocol.js";
import { PORT_ENV } from "../src/constants.js";
import type { Platform } from "./device.js";
import {
	CLOSE_TIMEOUT_MS,
	CONNECT_WAIT_MS,
	SHUTDOWN_MESSAGE,
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

type Waiter = { wake: () => void; cancel: (reason: Error) => void };

function safeToIgnore<T>(promise: Promise<T>): Promise<T> {
	promise.catch(() => {});
	return promise;
}

export class AppConnection {
	private connections: Connection[] = [];
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private waiters: Waiter[] = [];
	private closed = false;
	private bindError: NodeJS.ErrnoException | null = null;
	preferred: Platform | null = (process.env[ENV.platform] as Platform | undefined) ?? null;

	private readonly server: WebSocketServer;
	private readonly requestedPort: number;

	readonly listening: Promise<void>;

	constructor(requestedPort: number) {
		this.requestedPort = requestedPort;

		const host = process.env[ENV.host] ?? LOOPBACK_HOST;
		const server = new WebSocketServer({ port: requestedPort, host });
		this.server = server;
		this.listening = safeToIgnore(
			new Promise<void>((resolve, reject) => {
				const failStartup = (error: NodeJS.ErrnoException) => {
					this.bindError = error;
					for (const waiter of [...this.waiters]) waiter.cancel(new Error(this.listenFailure ?? error.message));
					reject(error);
				};
				server.once("error", failStartup);
				server.once("listening", () => {
					server.off("error", failStartup);
					resolve();
				});
			}),
		);

		const reachableBeyondLoopback = !LOOPBACK_HOSTS.has(host);
		if (reachableBeyondLoopback) {
			process.stderr.write(
				`[agent-jet-mcp] WARNING: listening on ${host}, which is reachable from your network. ` +
					`There is no authentication, so anyone who can reach port ${requestedPort} can impersonate your app. ` +
					`Only do this on a trusted network.\n`,
			);
		}

		server.on("connection", (socket) => this.accept(socket));
		server.on("error", (error) => {
			process.stderr.write(`[agent-jet-mcp] websocket server error: ${error.message}\n`);
		});
	}

	close(): Promise<void> {
		this.closed = true;
		for (const waiter of [...this.waiters]) waiter.cancel(new Error(SHUTDOWN_MESSAGE));

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

	get listenFailure(): string | null {
		if (!this.bindError) return null;

		const portIsTaken = this.bindError.code === "EADDRINUSE";
		if (!portIsTaken) return `This server could not listen on port ${this.requestedPort}: ${this.bindError.message}`;

		return (
			`Port ${this.requestedPort} is already in use, so this server is not listening and no app can reach it. ` +
			`Another agent-jet server has it — a second editor, or another app's session. ` +
			`Give this one its own port with ${ENV.port}, and start the app with ${PORT_ENV} set to the same number.`
		);
	}

	get port(): number {
		const address = this.server.address();
		return typeof address === "object" && address !== null ? address.port : this.requestedPort;
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
				const stillWaiting = [...this.waiters];
				for (const waiter of stillWaiting) waiter.wake();
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
		if (this.closed) return Promise.reject(new Error(SHUTDOWN_MESSAGE));

		const problem = this.listenFailure;
		if (problem) return Promise.reject(new Error(problem));

		const wanted = platform ?? this.preferred ?? undefined;
		const existing = this.connectionFor(wanted);
		if (existing) return Promise.resolve(existing);

		return new Promise((resolve, reject) => {
			const stopWaiting = () => {
				clearTimeout(timer);
				this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
			};

			const timer = setTimeout(() => {
				stopWaiting();
				const want = wanted ? `${wanted} app` : "app";
				reject(
					new Error(
						`No ${want} connected on ws://localhost:${this.port}. Is it running in a dev build with useAgentJet() called?`,
					),
				);
			}, timeoutMs);

			const waiter: Waiter = {
				wake: () => {
					const match = this.connectionFor(wanted);
					if (!match) return;
					stopWaiting();
					resolve(match);
				},
				cancel: (reason) => {
					stopWaiting();
					reject(reason);
				},
			};

			this.waiters.push(waiter);
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
