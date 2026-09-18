# React Native Agent Jet

**Let coding agents see and drive your running React Native / Expo app** — on the iOS Simulator or an Android emulator, through [MCP](https://modelcontextprotocol.io).

Playwright gives web agents a DOM, selectors, clicks, console and network. On mobile, agents have been stuck squinting at screenshots and guessing at pixel coordinates. Agent Jet closes that gap: a tiny bridge runs inside your dev build and exposes the **React tree itself**, so an agent can read the screen and act on it by name.

```
agent> press "Add to cart"
agent> tree changesSince:true
       ~ #44 Text "Cart (1)"   ← confirmed, in ~10 tokens
```

---

## What you get

|                                  |                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🌳 **Semantic tree**             | Every element with text, `testID`, label, `onPress`, input or scroll view — walked from React Fiber. No `testID`s required, no per-component setup. |
| 🎯 **Actions by selector**       | `press`, `type_text`, `set_text`, `scroll`, `navigate`, `go_back` — by text/label/testID, not coordinates.                                          |
| 🧭 **State & routing**           | The focused route, TanStack Query cache, and any value a component exposes with one hook.                                                           |
| 🪵 **Logs & network**            | Console output, uncaught errors (incl. RedBox), and HTTP traffic, captured in-app.                                                                  |
| 📸 **Real input when needed**    | Screenshots, keystrokes, taps and swipes via `xcrun simctl` + [AXe](https://github.com/cameroncooke/AXe) (iOS) and `adb` (Android).                 |
| 🫙 **Zero production footprint** | One hook, compiled out of production bundles entirely.                                                                                              |

Works with **React Navigation** and **Expo Router**, on iOS and Android, and runs in **Expo Go** — no native rebuild needed to try it.

---

## How it connects

There are three pieces. You don't manage the connection between them — it happens automatically — but knowing what talks to what makes the setup obvious:

```
Your coding agent  ──calls tools──▶  MCP server        ──WebSocket──▶  The bridge
(Claude Code,                        (runs on your Mac,                (runs inside your
 Cursor, …)                           started by the agent)             app — dev only)
```

- **The bridge** is a library you add to your app. In development it reads the React tree and opens a WebSocket to your Mac. In production it is compiled out entirely (see [Production](#production)).
- **The MCP server** runs on your Mac as the other end of that WebSocket, and exposes the [tools](#tools) (`tree`, `press`, `navigate`, …) to your agent.
- **Your coding agent** calls those tools to see and drive the app.

So setup is three small things: add the bridge, turn it on in your app, and point your agent at the server.

## Quick start

> **Prefer to let an agent do it?** Paste the output of `npx react-native-agent-jet setup-prompt` into your coding agent and it will run the install, register itself, add the hook to your root component, and verify — the manual steps below, done for you. (You'll still restart the agent once at the end so it loads the new server.)

### 1. Add the bridge to your app

```bash
bun add react-native-agent-jet      # or npm / pnpm / yarn
```

### 2. Turn it on in your app

Call `useAgentJet` once, in the top-level component where your navigation lives. `navigationRef` and `queryClient` are **your app's existing objects** — pass whichever you already have (both are optional; they just unlock the `navigate` and `state` tools).

```tsx
import { useAgentJet } from "react-native-agent-jet";

function App() {
	const navigationRef = useNavigationContainerRef(); // your app already has this

	useAgentJet({ navigationRef, queryClient, appName: "my-app" });

	return <NavigationContainer ref={navigationRef}>{/* your app */}</NavigationContainer>;
}
```

That is the only code you write, and it does nothing in production.

> Using **Expo Router**? It's one extra prop — see [Framework setup](#framework-setup).

### 3. Point your agent at it

Run this in your project's root folder:

```bash
npx react-native-agent-jet init
```

It sets up the agent side and prints a checklist of what it found. Specifically it:

- **registers the MCP server** in the config your agent reads,
- **installs a skill** at `.claude/skills/agent-jet/SKILL.md` so the agent already knows how to use the tools,
- **checks your tooling** (simulator, AXe, adb) and tells you if anything is missing.

By default it configures **Claude Code**. Pick your agent with `--client`:

```bash
npx react-native-agent-jet init --client cursor
npx react-native-agent-jet init --client codex          # or claude, vscode, windsurf, gemini, zed
npx react-native-agent-jet init --client claude,codex   # several at once
npx react-native-agent-jet init --client all            # every supported client
```

| `--client` | Registers in                          |
| ---------- | ------------------------------------- |
| `claude`   | `.mcp.json`                           |
| `cursor`   | `.cursor/mcp.json`                    |
| `vscode`   | `.vscode/mcp.json`                    |
| `gemini`   | `.gemini/settings.json`               |
| `zed`      | `.zed/settings.json`                  |
| `codex`    | `~/.codex/config.toml`                |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |

It merges into an existing config (keeping your other servers) and is safe to re-run.

<details>
<summary>More options</summary>

- `--skill false` skips the skill; `--playbook true` also appends the playbook to `CLAUDE.md`.
- Any other MCP client can run the server directly — see [Other MCP clients](#other-mcp-clients).

</details>

### 4. Try it

Restart your agent so it loads the new MCP server, start your app in the simulator, and ask the agent to **call `status`**. If it reports your app as connected, you're done — ask it to `tree`, then start driving.

> **Not connecting?** Run `npx react-native-agent-jet doctor`. It re-checks each step — install, registration, simulator, AXe/adb, and whether the app is actually talking to the server — and points at whichever one failed.

> **Optional: real taps and keystrokes on iOS.** Everything works without this, but for real gestures (rather than React-level presses) install [AXe](https://github.com/cameroncooke/AXe):
>
> ```bash
> brew install cameroncooke/axe/axe
> ```
>
> Android uses `adb` (bundled with the Android platform-tools). Without either, you still get the tree, presses, typing, navigation, state, logs and network — you only lose screenshots and real gestures.

---

## Framework setup

### Expo Router

Pass Expo Router's `router` alongside the container ref. Navigation then works by **path**:

```tsx
import { router, Stack, useNavigationContainerRef } from "expo-router";
import { useAgentJet } from "react-native-agent-jet";

export default function RootLayout() {
	const navigationRef = useNavigationContainerRef();
	useAgentJet({ navigationRef, router, queryClient });
	return <Stack>{/* … */}</Stack>;
}
```

Now `navigate("/catalog")` and `navigate("/detail/42")` work from any screen; everything else is identical.

> A complete, runnable Expo Router app lives in [`example/`](./example) — the harness this package is developed against.

### React Navigation

Pass the container ref (shown in the quick start). `navigate` takes a **route name** — `navigate("Search")` — and resolves nested navigators automatically, from any screen.

### Driving iOS and Android at once

Run both an iOS app and an Android app at the same time — the server keeps a connection to each. Every tool takes an optional `platform`, so an agent can target either without switching modes:

```
tree platform:"ios"
tree platform:"android"          # same screen on both, compared in one session
press "Checkout" platform:"ios"
press "Checkout" platform:"android"
```

With no `platform`, tools use the active app (the most recently connected, or whatever `select_platform` last set). One app per platform connects at a time.

### Other MCP clients

`init` targets Claude Code and Cursor, but any MCP client works — run the server over stdio directly:

```bash
npx react-native-agent-jet mcp
```

It listens for the app on `ws://localhost:8765` (override with `AGENT_JET_PORT`, and pass a matching `url` to `useAgentJet`).

---

## Exposing app state

Surface live values from any component by key; the agent reads them with the `state` tool.

```tsx
import { useAgentJetState } from "react-native-agent-jet";

function Checkout() {
	const cart = useCart();
	useAgentJetState("cart", { items: cart.items.length, total: cart.total });
}
```

For state outside React, register a getter (it returns an unregister function):

```ts
import { registerAgentJetState } from "react-native-agent-jet";

registerAgentJetState("session", () => sessionStore.getState());
```

Passing a `queryClient` to `useAgentJet` adds a `queries` key summarizing the TanStack Query cache. No hooks? `startAgentJet(options)` does the same imperatively.

---

## Tools

**See the screen**

| Tool                | What it does                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tree`              | The semantic tree of what's on screen. `interactive:true` for actionable nodes only · `changesSince:true` for just what changed · `frames:true` for coordinates · `format:"json"` to parse |
| `find` · `wait_for` | Locate elements by target; `wait_for` polls until one appears                                                                                                                              |
| `nav_state`         | The focused route and path (`full:true` for the whole navigation tree)                                                                                                                     |
| `state`             | Values exposed via `useAgentJetState` / `registerAgentJetState` / `queryClient`                                                                                                            |
| `logs` · `network`  | Captured console output, errors, and HTTP traffic                                                                                                                                          |
| `screenshot`        | A PNG (1px = 1pt / dp), for when you need to _see_                                                                                                                                         |

**Act**

| Tool                     | What it does                                                                   |
| ------------------------ | ------------------------------------------------------------------------------ |
| `press`                  | Fire an element's `onPress` via React (instant); `via:"touch"` for a real tap  |
| `type_text` · `set_text` | Type real keystrokes into an input, or set its value directly                  |
| `scroll_to` · `swipe`    | Programmatic scroll (any ScrollView/FlatList/FlashList), or a real swipe       |
| `navigate` · `go_back`   | Navigate by route name (React Navigation) or path (Expo Router), from anywhere |

**Raw input** (for things React can't see, like system alerts)

| Tool                                 | What it does                                  |
| ------------------------------------ | --------------------------------------------- |
| `tap` · `press_key` · `press_button` | Coordinate tap, keyboard key, hardware button |
| `native_tree`                        | The OS accessibility tree (AXe / uiautomator) |

**Session & device**

| Tool                                                                                     | What it does                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `status`                                                                                 | Connected apps, device info, and whether AXe/adb are available |
| `select_platform`                                                                        | Choose iOS or Android when both are connected                  |
| `open_url` · `reload` · `launch_app` · `terminate_app` · `set_appearance` · `clear_logs` | App and device lifecycle                                       |

### Targets

Every element tool takes a `target`:

- **A string** matches a `testID` exactly, or text / label / placeholder / value by case-insensitive substring, or `#id` from the tree.
- **An object** narrows by field: `{ testID }`, `{ text, exact: true }`, `{ label }`, `{ type: "TextInput", index: 1 }`.

`press` targets the nearest pressable, so `press("Save")` works whether the label sits on the button or inside it.

---

## Token efficiency

Agents drive this by reading a tree and acting on selectors — not by screenshotting every step. The act-and-verify loop that dominates a session is roughly **20–50× cheaper** than screenshot-driving, where each step is a ~1,000–1,600-token image the model must vision-parse.

Approximate output tokens per call (demo Home screen):

| Call                         |       Tokens |                                           |
| ---------------------------- | -----------: | ----------------------------------------- |
| `find` / `press`             |          ~15 | a single element                          |
| `tree` · `changesSince:true` |   **~10–40** | only what changed — the usual verify step |
| `nav_state`                  |          ~30 | route + path (`full:true` ≈ 160)          |
| `tree` · `interactive:true`  |          ~70 | actionable nodes only                     |
| `tree` (default)             |         ~165 | whole screen, no coordinates              |
| `tree` · `frames:true`       |         ~290 | adds coordinates                          |
| `screenshot`                 | ~1,000–1,600 | it's an image                             |

The defaults lean this way on purpose: `tree` omits coordinates (selectors don't need them), `nav_state` returns just the path, and `changesSince:true` turns verification into a diff. On busy screens that's exactly where `interactive:true` and `changesSince:true` earn their keep.

---

## Production

The hook you add ships **nothing** to production. Every public function is a thin wrapper that only loads its real implementation inside `if (__DEV__)`:

```ts
// this is the entire production-facing surface
export function useAgentJet(options = {}) {
	if (__DEV__) {
		require("./hooks").useAgentJetDev(options); // dev-only; require() is inside the branch
	}
}
```

Metro replaces `__DEV__` with `false` in release builds and its minifier removes the dead `if (false) { … }` branch. Because the `require("./hooks")` sits inside that branch, the entire implementation — the Fiber walker, the WebSocket client, the log/network capture — is never reached, so it's never bundled. What remains is an empty function.

**Proof, from a release export of the [`example/`](./example) app** (`expo export`, i.e. `__DEV__ = false`), grepping the output bundle:

```
getFiberRoots        0    ← the Fiber walker
installCapture       0    ← log/network capture
useAgentJetDev       0    ← the real hook implementation
"connected to ws"    0    ← the WebSocket client
8765                 0    ← the default port

Agent Jet Demo       1    ← (sanity check) the app's own code is present
```

Every bridge internal is absent; only the empty wrapper name survives. Nothing to strip by hand, no config, no separate production build.

---

## How it works

- **Reading the screen** — the bridge uses the same `__REACT_DEVTOOLS_GLOBAL_HOOK__` React DevTools relies on, walks each root's Fiber tree, and keeps only meaningful nodes (text, `testID`, accessibility props, `onPress`, inputs, scroll views). Wrapper chains collapse to one node, inactive navigator screens are skipped, and frames come from Fabric's `measureInWindow`.
- **Acting** — targets resolve against a fresh snapshot each time and act on the fiber directly: `onPress` gets a synthetic event, inputs are focused and updated through `onChangeText`, scroll views use `scrollTo`. Real input (screenshots, keystrokes, taps) goes through `xcrun simctl` / AXe / `adb`.
- **Logs & network** — `console` and `XMLHttpRequest`/`fetch` are patched once and buffered, so an agent can ask for everything since the last entry it saw.
- **Transport** — the app is a WebSocket client, the MCP server is the WebSocket server, so the app finds the host on `localhost` (or `10.0.2.2` on Android) with no simulator config.

---

## Platform support

| Your machine        | iOS Simulator                                  | Android emulator / device |
| ------------------- | ---------------------------------------------- | ------------------------- |
| **macOS**           | ✅ full                                        | ✅ full                   |
| **Windows / Linux** | — Apple only allows the iOS Simulator on macOS | ✅ full                   |

On Windows and Linux you drive Android exactly as on macOS — `adb` is cross-platform and handles taps, typing, screenshots and lifecycle. The only difference: screenshots come back at the device's native resolution (macOS auto-downscales them with `sips`), which just means slightly larger images. Everything the agent reads and does — `tree`, `press`, `navigate`, `state`, `logs`, `network` — is identical, since that all runs inside the app.

iOS itself is macOS-only because the iOS Simulator is.

---

## Caveats

- **iOS real taps are slow.** AXe serializes the whole accessibility tree before each gesture (several seconds on busy screens), so `press` defaults to firing `onPress` through React. Android taps via `adb` are ~100ms. Keystrokes are instant on both.
- **Physical devices** need the host's IP on both ends: start the server with `AGENT_JET_HOST=0.0.0.0` and point the app at it with `useAgentJet({ url: "ws://<your-mac-ip>:8765" })`. The server otherwise listens on localhost only, and the connection is unauthenticated, so only do that on a network you trust. Simulators and emulators need neither.
- **Android text** via `adb` is ASCII-only; `set_text` covers everything else.
- **`logs` and `network` try to redact secrets — finishing the job is up to you.** Common cases are handled: values under keys like `password`, `token`, `apiKey` or `cookie`, plus JWTs and `Bearer …` values, are replaced with `[redacted]` before anything is stored. Treat that as a convenience, not a guarantee. The package cannot know what counts as sensitive in your app, and anything it does not recognise is passed through to your agent as-is, so **redacting everything your application needs redacted is your responsibility.** Field names, status and timing are always preserved, so the agent can still debug the request.

  ```tsx
  useAgentJet({
  	redact: {
  		keys: ["memberNumber", "policy_id"], // extra field names
  		patterns: [/sk_live_[A-Za-z0-9]+/], // extra value shapes, anywhere they appear
  	},
  });
  ```

  Keys match case- and separator-insensitively, patterns catch secrets sitting under innocuous field names, and both add to the defaults rather than replacing them. Patterns run against every captured body, so keep them anchored and cheap. Pass `redact: false` to disable scrubbing entirely.

- **iOS and Android can run together** — one app per platform. Pass `platform` per call to target either; the active app is used otherwise. See [Driving iOS and Android at once](#driving-ios-and-android-at-once).
- **Fiber internals** aren't a public React API — but they're the same fields React DevTools depends on, verified against React 19 / React Native 0.85 (New Architecture).

---

## Development

```bash
bun install
bun run typecheck
bun run build     # builds the host (MCP server + CLI) into dist/
```

`src/` runs inside the app (shipped as TypeScript, compiled by Metro); `host/` runs on your machine. To develop against a local checkout, see [`docs/local-development.md`](./docs/local-development.md).

---

## License

MIT
