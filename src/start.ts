import { installCapture } from "./capture";
import { connect, defaultUrl, markStarted } from "./connection";
import { setOptions, type AgentJetOptions } from "./handles";

export function startAgentJet(options: AgentJetOptions = {}): void {
	setOptions(options);
	const isFirstStart = markStarted();
	if (!isFirstStart) return;
	installCapture();
	connect(options.url ?? defaultUrl());
}
