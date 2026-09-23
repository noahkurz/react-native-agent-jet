const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const config = getDefaultConfig(__dirname);

const jetPath = fs.realpathSync(path.join(__dirname, "node_modules/react-native-agent-jet"));

const onlyTheAppHasACopyOf = (moduleName) =>
	["react", "react-native", "expo"].includes(moduleName) || moduleName.startsWith("expo/");

config.watchFolders = [...(config.watchFolders ?? []), jetPath];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (onlyTheAppHasACopyOf(moduleName) && context.originModulePath.startsWith(jetPath)) {
		return context.resolveRequest(
			{ ...context, originModulePath: path.join(__dirname, "index.js") },
			moduleName,
			platform,
		);
	}
	return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
