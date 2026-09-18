import { Platform } from "react-native";
import { originalConsole } from "./capture";
import { deviceInfo, dispatch } from "./dispatch";
import type { Hello, Request, Response } from "./protocol";
import { version } from "../package.json";

export const DEFAULT_PORT = 8765;
export const VERSION = version;

const RECONNECT_MS = 250;

export function defaultUrl(): string {
	const host = Platform.OS === "android" ? "10.0.2.2" : "localhost";
	return `ws://${host}:${DEFAULT_PORT}`;
}

type Shared = {
	socket: WebSocket | null;
	stopped: boolean;
	started: boolean;
	dispatch: typeof dispatch;
};

const shared: Shared = ((globalThis as { __reactNativeAgentJet?: Shared }).__reactNativeAgentJet ??= {
	socket: null,
	stopped: false,
	started: false,
	dispatch,
});
shared.dispatch = dispatch;

export function markStarted(): boolean {
	if (shared.started) return false;
	shared.started = true;
	return true;
}

function log(message: string) {
	originalConsole.log(`[agent-jet] ${message}`);
}

async function handle(socket: WebSocket, raw: string) {
	let request: Request;
	try {
		request = JSON.parse(raw) as Request;
	} catch {
		return;
	}
	let response: Response;
	try {
		const result = await shared.dispatch(request.method, request.params);
		response = { id: request.id, ok: true, result };
	} catch (error) {
		response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

export function connect(url: string) {
	if (shared.stopped || shared.socket) return;
	let ws: WebSocket;
	try {
		ws = new WebSocket(url);
	} catch {
		setTimeout(() => connect(url), RECONNECT_MS);
		return;
	}
	shared.socket = ws;
	ws.onopen = () => {
		const hello: Hello = { type: "hello", device: deviceInfo(), version: VERSION };
		ws.send(JSON.stringify(hello));
		log(`connected to ${url}`);
	};
	ws.onmessage = (event) => {
		void handle(ws, String(event.data));
	};
	ws.onerror = () => {};
	ws.onclose = () => {
		if (shared.socket === ws) shared.socket = null;
		if (!shared.stopped) setTimeout(() => connect(url), RECONNECT_MS);
	};
}

export function disconnect() {
	shared.stopped = true;
	shared.socket?.close();
	shared.socket = null;
}
