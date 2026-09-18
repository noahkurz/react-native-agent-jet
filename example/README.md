# Agent Jet demo app

A tiny Expo Router app for developing and demoing [react-native-agent-jet](../) without depending on a real product app.

## What it exercises

- **Tabs** (Home / Catalog / Settings) and a **pushed detail screen** (`/detail/[id]`)
- **State** via `useAgentJetState` (the Home counter, Settings form)
- **A network request** (`Catalog` fetches from jsonplaceholder) so `network` capture has something to show
- **Text inputs** (Catalog filter, Settings name) for `type_text` / `set_text`
- **Expo Router navigation** wired through `useAgentJet({ navigationRef, router, queryClient })`

## Run it

```bash
bun install
bun run ios      # or: bun run android
```

It runs in **Expo Go** — no native build required. The bridge connects to the `react-native-agent-jet-mcp` server on `ws://localhost:8765` automatically.

The `react-native-agent-jet` dependency points at the parent repo via `bun link`, so edits to the bridge hot-reload here.
