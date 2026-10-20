const { getDefaultConfig } = require("expo/metro-config");
const fs = require("node:fs");
const path = require("node:path");
const apiMiddleware = require("./server/api-router");

const config = getDefaultConfig(__dirname);
config.server.enhanceMiddleware = (middleware) => (req, res, next) =>
  apiMiddleware(req, res, () => middleware(req, res, next));
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "./apiKeys.local" &&
    context.originModulePath === path.join(__dirname, "config/apiKeys.ts") &&
    !fs.existsSync(path.join(__dirname, "config/apiKeys.local.ts"))
  ) {
    return {
      type: "sourceFile",
      filePath: path.join(__dirname, "config/apiKeys.empty.ts"),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
