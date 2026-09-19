import { Platform } from "react-native";
import { ANDROID_EMULATOR_HOST, DEFAULT_PORT, LOCALHOST } from "./constants";
import { originalConsole } from "./capture";
import { deviceInfo, dispatch } from "./dispatch";
import { HELLO, type Hello, type Request, type Response } from "./protocol";
import { version } from "../package.json";

export { DEFAULT_PORT };
const VERSION = version;

const RECONNECT_MS = 250;

export function defaultUrl(): string {
	const host = Platform.OS === "android" ? ANDROID_EMULATOR_HOST : LOCALHOST;
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

	const socketIsStillOpen = socket.readyState === WebSocket.OPEN;
	if (socketIsStillOpen) socket.send(JSON.stringify(response));
}

export function connect(url: string) {
	const alreadyConnectedOrShutDown = shared.stopped || Boolean(shared.socket);
	if (alreadyConnectedOrShutDown) return;

	let ws: WebSocket;
	try {
		ws = new WebSocket(url);
	} catch {
		setTimeout(() => connect(url), RECONNECT_MS);
		return;
	}

	shared.socket = ws;

	ws.onopen = () => {
		const hello: Hello = { type: HELLO, device: deviceInfo(), version: VERSION };
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
