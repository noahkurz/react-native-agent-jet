import { useEffect, useRef } from "react";
import { registerAgentJetState, setOptions, type AgentJetOptions } from "./handles";
import { startAgentJet } from "./start";

export function useAgentJetDev(options: AgentJetOptions): void {
	setOptions(options);
	useEffect(() => {
		startAgentJet(options);
	}, []);
}

export function useAgentJetStateDev(key: string, value: unknown): void {
	const latest = useRef(value);
	latest.current = value;
	useEffect(() => registerAgentJetState(key, () => latest.current), [key]);
}
