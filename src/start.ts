import { installCapture } from "./capture";
import { connect, defaultUrl, markStarted } from "./connection";
import { setOptions, type AgentJetOptions } from "./handles";

export function startAgentJet(options: AgentJetOptions = {}): void {
	setOptions(options);
	if (!markStarted()) return;
	installCapture();
	connect(options.url ?? defaultUrl());
}
