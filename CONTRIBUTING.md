# Contributing

Thanks for looking. Issues and pull requests are both welcome, and a good bug report is worth as much as a patch.

## Reporting a bug

Run `npx react-native-agent-jet doctor` from your app's root and paste the output into the issue. It checks the install, the MCP registration, the simulator or emulator, whether real input is available, and whether the app is actually talking to the server — which is most of what anyone would ask you anyway. The bug report template asks for the rest.

## Getting set up

```bash
bun install
bun run typecheck
bun test          # no device needed
bun run build     # builds the host (MCP server + CLI) into dist/
```

`example/` is a small Expo Router app for driving the package by hand. It links the parent checkout, which needs a little Metro configuration — [`docs/local-development.md`](./docs/local-development.md) has it.

## The two halves

`src/` runs **inside the app**. It ships as TypeScript and is compiled by Metro, so it may only use React Native APIs, and anything it does costs the user's bundle. `host/` runs **on your machine** as the MCP server and CLI, on Node, where the whole standard library is fair game. They meet over a WebSocket, and `src/protocol.ts` is the contract.

## What a good pull request looks like

- **Tests that fail without the change.** The suite runs with no device attached; keep it that way. If you fix a bug, the test that proves it should fail on `main`.
- **Driven against a real app** for anything that touches a tool's behaviour. Unit tests do not catch a crop landing in the wrong place or a reply that reads badly to an agent. Say in the PR which platform you drove and what you did.
- **`bun run typecheck`, `bun test` and `bun run format:check` all green.** Formatting is Prettier with the repo's config; `bun run format` fixes it.
- **Self-documenting code.** The house style is that a comment is a sign a name or a shape could be better, so most of this codebase has none. Prefer extracting a well-named function or binding a named constant over explaining a line. Where a reason genuinely cannot live in the code — a platform quirk, a workaround for something upstream — put it in the pull request description or the commit message, where it is attached to the change rather than to the line.
- **Tokens are a feature.** Every tool reply is read by a model and billed by the token. If a change makes a reply longer, say what it buys. The README's token table is measured with `count_tokens`, not estimated.

## Changes to CI

A pull request runs the workflow from its own branch, so an altered `.github/workflows/` file could report a passing check without having run anything. Those paths are owned by the maintainer, and a pull request touching them needs their approval before it can merge. Everything else merges on a green check alone.

## Commits

Short, imperative subject lines, lowercase, with a `type:` prefix (`fix:`, `feat:`, `perf:`, `refactor:`, `docs:`, `chore:`). The body is for _why_, and for anything a reviewer would otherwise have to reconstruct.

## Releases

Maintainers only: bump `package.json`, tag `vX.Y.Z`, publish the GitHub release, then `npm publish`. Both the host and the bridge read their version from `package.json`, so there is only one number to change.
