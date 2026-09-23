const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const config = getDefaultConfig(__dirname);

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

module.exports = config;
