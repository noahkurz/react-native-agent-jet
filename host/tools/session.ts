/** Tools that manage the session and the device itself. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { android } from "../android.js";
import { deviceFor } from "../devices.js";
import { ios } from "../ios.js";
import { type ToolContext, platformSchema, text } from "./shared.js";

export function registerSessionTools(server: McpServer, { app, lastTree }: ToolContext) {
	server.registerTool(
		"select_platform",
		{
			description:
				"Set the DEFAULT platform to drive when both iOS and Android are connected. Optional — every tool also takes a per-call `platform`, so you can drive both without switching. Defaults to the most recently connected app.",
			inputSchema: { platform: z.enum(["ios", "android"]) },
		},
		async ({ platform }) => {
			app.preferred = platform;
			return text(
				`Driving ${platform}${app.connected ? ` (${app.device?.appName ?? "app"} connected)` : " (no app connected yet)"}`,
			);
		},
	);
	server.registerTool(
		"clear_logs",
		{ description: "Clear captured logs and network entries.", inputSchema: { platform: platformSchema } },
		async ({ platform }) => {
			await app.request("clear", {}, platform);
			return text("Cleared");
		},
	);
	server.registerTool(
		"open_url",
		{
			description: "Open a URL or deep link on the device (e.g. your app scheme).",
			inputSchema: { url: z.string(), platform: platformSchema },
		},
		async ({ url, platform }) => {
			await (await deviceFor(app, platform)).openUrl(url);
			return text(`Opened ${url}`);
		},
	);
	server.registerTool(
		"reload",
		{ description: "Reload the JS bundle (like pressing r in Metro).", inputSchema: { platform: platformSchema } },
		async ({ platform }) => {
			await app.request("reload", {}, platform);
			return text("Reloading");
		},
	);
	server.registerTool(
		"launch_app",
		{
			description: "Launch an app by bundle identifier (iOS) or package name (Android).",
			inputSchema: { bundleId: z.string(), platform: platformSchema },
		},
		async ({ bundleId, platform }) => {
			await (await deviceFor(app, platform)).launchApp(bundleId);
			return text(`Launched ${bundleId}`);
		},
	);
	server.registerTool(
		"terminate_app",
		{
			description: "Terminate an app by bundle identifier (iOS) or package name (Android).",
			inputSchema: { bundleId: z.string(), platform: platformSchema },
		},
		async ({ bundleId, platform }) => {
			await (await deviceFor(app, platform)).terminateApp(bundleId);
			return text(`Terminated ${bundleId}`);
		},
	);
	server.registerTool(
		"set_appearance",
		{
			description: "Switch the device between light and dark mode.",
			inputSchema: { mode: z.enum(["light", "dark"]), platform: platformSchema },
		},
		async ({ mode, platform }) => {
			await (await deviceFor(app, platform)).setAppearance(mode);
			return text(`Appearance set to ${mode}`);
		},
	);
	server.registerTool(
		"native_tree",
		{
			description:
				"The native accessibility tree (AXe on iOS, uiautomator on Android). Fallback when the app is not connected; less informative than tree.",
			inputSchema: { platform: platformSchema },
		},
		async ({ platform }) => text(await (await deviceFor(app, platform)).describeNativeUi()),
	);
}
