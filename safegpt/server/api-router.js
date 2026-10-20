// Adapt the repository's existing Vercel handlers to Node/Metro without
// changing their request/response contracts or duplicating provider logic.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const apiRoot = path.resolve(__dirname, "../../api");
const cache = new Map();
const routes = new Set([
  "chat",
  "status",
  "search",
  "local",
  "transcribe",
  "tts",
  "session",
  "emergency",
  "gemini-upload-url",
  "gemini-file-status",
]);

function loadHandler(name) {
  return loadTypeScript(path.join(apiRoot, `${name}.ts`));
}

function loadTypeScript(filename) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (id) => {
    if (id.startsWith(".")) {
      const candidate = path.resolve(path.dirname(filename), id);
      if (fs.existsSync(`${candidate}.ts`)) return loadTypeScript(`${candidate}.ts`);
    }
    return originalRequire(id);
  };
  cache.set(filename, mod);
  try {
    mod._compile(outputText, filename);
    return mod.exports;
  } catch (error) {
    cache.delete(filename);
    throw error;
  }
}

module.exports = function apiMiddleware(req, res, next) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return next();
  const name = pathname.slice(5);
  res.setHeader("Cache-Control", "no-store");
  if (!routes.has(name)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Unknown API endpoint" }));
  }
  Promise.resolve().then(() => loadHandler(name).default(req, res)).catch((error) => {
    console.error(`API ${name} failed:`, error.message);
    if (res.headersSent) return res.end();
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "API request failed" }));
  });
};
