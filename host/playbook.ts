export const PLAYBOOK_MARKER = "<!-- react-native-agent-jet -->";

const STEPS = `- Call \`tree\` once to see everything on screen: text, labels, testIDs, inputs and pressables. Use it instead of guessing from screenshots.
- Prefer \`press\`, \`type_text\` and \`navigate\` with targets over coordinate taps.
- After an action, call \`tree\` with \`changesSince:true\` to see only what changed (cheap), and \`logs\` for errors.
- Use \`interactive:true\` on busy screens, and only ask for \`frames:true\` or \`screenshot\` when you need coordinates or a visual.
- \`nav_state\` gives the focused route path; \`navigate\` jumps to a screen by route name (React Navigation) or path (Expo Router) from anywhere.
- \`state\` reads values the app exposes; \`network\` shows HTTP traffic; Fast Refresh applies JS edits, \`reload\` restarts the bundle.`;

export const PLAYBOOK = `${PLAYBOOK_MARKER}
## Driving the app with react-native-agent-jet

The \`jet\` MCP server drives the running React Native / Expo app in the simulator.

${STEPS}
`;

export const SKILL = `---
name: agent-jet
description: See and drive the running React Native / Expo app in the iOS Simulator or Android emulator through the jet MCP tools. Use whenever verifying a UI change in the real app, navigating its screens, reproducing a bug, or checking what the app renders, logs, or requests.
---

# Driving the app with react-native-agent-jet

The \`jet\` MCP server is connected to the running app. Reach for it whenever you would otherwise guess from a screenshot.

${STEPS}

## Loop

1. \`status\` — confirm an app is connected (and which platform).
2. \`tree\` — read the current screen.
3. Act: \`press\` / \`type_text\` / \`navigate\` with a target.
4. \`tree\` with \`changesSince:true\` — confirm just what changed; \`logs\`/\`network\` if something looks wrong.

## Targets

A string matches a testID exactly, or text/label/placeholder/value by case-insensitive substring, or \`#id\` from the tree. An object narrows: \`{ testID }\`, \`{ text, exact:true }\`, \`{ type:"TextInput", index:1 }\`.
`;

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export function addCommand(pm: PackageManager, pkg = "react-native-agent-jet"): string {
	return pm === "npm" ? `npm install ${pkg}` : `${pm} add ${pkg}`;
}

export const SETUP_PROMPT = `Set up react-native-agent-jet in this project so I can drive the app from here. Do all of it:

1. Install the package with the project's package manager (bun/npm/pnpm/yarn — check the lockfile):
   e.g. \`bun add react-native-agent-jet\`
2. Run \`npx react-native-agent-jet init --client <this agent>\` (claude, cursor, vscode, codex, windsurf, gemini, or zed). This registers the MCP server and writes the skill.
3. Add the hook to the app's root component (the top-level file where navigation is set up — e.g. app/_layout.tsx for Expo Router, or App.tsx):
   - import { useAgentJet } from "react-native-agent-jet";
   - call it once: useAgentJet({ navigationRef, queryClient, appName: "<app name>" });
   - Wire whatever the app already has: for React Navigation pass the container ref; for Expo Router pass { router, navigationRef } (from expo-router's useNavigationContainerRef()); pass queryClient if the app uses TanStack Query. All are optional.
   - Keep it dev-safe: the hook already compiles out of production, so no __DEV__ guard is needed.
4. Run \`npx react-native-agent-jet doctor\` and report what it says.
5. Tell me to restart this agent so it loads the new MCP server, then start the app in the simulator/emulator. After that, call \`status\` to confirm the app is connected.

Do not remove or reformat unrelated code. Show me the diff for the root component change.`;
