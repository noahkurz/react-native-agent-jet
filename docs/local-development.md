# Using a local checkout in your app

Run `bun link` in this repo, then `bun link react-native-agent-jet` in the app, and `bun run build` here whenever the host side changes (the app side hot-reloads through Fast Refresh).

`bun link` creates a symlink outside the app's root, which Metro does not watch by default. It also means the bridge would resolve `react`, `react-native` and `expo` from this repo's `node_modules` instead of the app's — and the virtual modules Expo's Babel preset injects would not resolve at all. Add this to the app's `metro.config.js`:

```js
const path = require("path");
const fs = require("fs");

const jetPath = fs.realpathSync(path.join(__dirname, "node_modules/react-native-agent-jet"));

// react and react-native must stay single copies, and expo (including the virtual modules
// babel-preset-expo injects, such as expo/virtual/env) only exists in the app.
const appOwns = (moduleName) =>
	["react", "react-native", "expo"].includes(moduleName) || moduleName.startsWith("expo/");

config.watchFolders = [...(config.watchFolders ?? []), jetPath];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (appOwns(moduleName) && context.originModulePath.startsWith(jetPath)) {
		return context.resolveRequest(
			{ ...context, originModulePath: path.join(__dirname, "index.js") },
			moduleName,
			platform,
		);
	}
	return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};
```

None of this is needed once you install the published package.

Do not ship a `link:` dependency to a cloud build service such as EAS: the linked folder is not part of the upload and the install will fail. Switch to the published version, or remove the dependency before building.

## Running the MCP server from source

`npx react-native-agent-jet init` in the app writes `.mcp.json` pointing at `node_modules/react-native-agent-jet/dist/host/mcp.js`, which resolves through the link to this checkout's build output. Rebuild with `bun run build` after editing `host/` and restart the MCP client.
