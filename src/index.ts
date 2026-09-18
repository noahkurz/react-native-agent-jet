import type { AgentJetOptions, StateValue } from "./handles";

export type { AgentJetOptions, StateValue, ExpoRouterLike } from "./handles";
export type * from "./protocol";

type DevModule = typeof import("./hooks");
type StartModule = typeof import("./start");
type HandlesModule = typeof import("./handles");

export function useAgentJet(options: AgentJetOptions = {}): void {
	if (__DEV__) {
		(require("./hooks") as DevModule).useAgentJetDev(options);
	}
}

export function useAgentJetState(key: string, value: unknown): void {
	if (__DEV__) {
		(require("./hooks") as DevModule).useAgentJetStateDev(key, value);
	}
}

export function startAgentJet(options: AgentJetOptions = {}): void {
	if (__DEV__) {
		(require("./start") as StartModule).startAgentJet(options);
	}
}

export function registerAgentJetState(key: string, value: StateValue): () => void {
	if (__DEV__) {
		return (require("./handles") as HandlesModule).registerAgentJetState(key, value);
	}
	return () => {};
}
