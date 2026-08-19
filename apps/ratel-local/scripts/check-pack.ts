import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");

const packageJson = await readJson<{
  version?: unknown;
  dependencies?: Record<string, unknown>;
}>(resolve(appRoot, "package.json"));
const requiredRatelSdkVersion = "0.9.1";
const ratelSdkVersion = packageJson.dependencies?.["@ratel-ai/sdk"];
if (ratelSdkVersion !== requiredRatelSdkVersion) {
  throw new Error(`@ratel-ai/sdk must be pinned exactly to ${requiredRatelSdkVersion}`);
}
const legacyTelemetryPins = {
  "@ratel-ai/telemetry": "0.1.2",
  "@ratel-ai/telemetry-otlp": "0.1.1",
} as const;
for (const [name, version] of Object.entries(legacyTelemetryPins)) {
  if (packageJson.dependencies?.[name] !== version) {
    throw new Error(`${name} must be pinned exactly to ${version}`);
  }
}
for (const workspacePackagePath of [
  "../../package.json",
  "../../packages/core/package.json",
  "../../packages/ui/package.json",
]) {
  const workspacePackage = await readJson<{
    version?: unknown;
    dependencies?: Record<string, unknown>;
  }>(resolve(appRoot, workspacePackagePath));
  if (workspacePackage.version !== packageJson.version) {
    throw new Error(
      `${workspacePackagePath} version ${String(workspacePackage.version)} does not match published package version ${String(packageJson.version)}`,
    );
  }
  if (
    workspacePackagePath === "../../packages/core/package.json" &&
    workspacePackage.dependencies?.["@ratel-ai/sdk"] !== requiredRatelSdkVersion
  ) {
    throw new Error(
      `${workspacePackagePath} must pin @ratel-ai/sdk exactly to ${requiredRatelSdkVersion}`,
    );
  }
}

for (const manifestPath of [
  "plugin/.codex-plugin/plugin.json",
  "plugin/.claude-plugin/plugin.json",
]) {
  const manifest = await readJson(resolve(appRoot, manifestPath));
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `${manifestPath} version ${String(manifest.version)} does not match package version ${String(packageJson.version)}`,
    );
  }
}

const expectedPluginSource = "./apps/ratel-local/plugin";
const claudeMarketplace = await readJson<{
  plugins?: Array<{ name?: unknown; source?: unknown }>;
}>(resolve(appRoot, "../../.claude-plugin/marketplace.json"));
const claudeMarketplaceEntry = claudeMarketplace.plugins?.find(
  (plugin) => plugin.name === "ratel-local",
);
if (claudeMarketplaceEntry?.source !== expectedPluginSource) {
  throw new Error(
    `../../.claude-plugin/marketplace.json must point ratel-local at ${expectedPluginSource}`,
  );
}

const codexMarketplace = await readJson<{
  plugins?: Array<{
    name?: unknown;
    source?: { source?: unknown; path?: unknown };
  }>;
}>(resolve(appRoot, "../../.agents/plugins/marketplace.json"));
const codexMarketplaceEntry = codexMarketplace.plugins?.find(
  (plugin) => plugin.name === "ratel-local",
);
if (
  codexMarketplaceEntry?.source?.source !== "local" ||
  codexMarketplaceEntry.source.path !== expectedPluginSource
) {
  throw new Error(
    `../../.agents/plugins/marketplace.json must point ratel-local at local source ${expectedPluginSource}`,
  );
}

const pluginMcp = await readJson<{
  mcpServers?: Record<string, { args?: unknown }>;
}>(resolve(appRoot, "plugin/.mcp.json"));
const pluginArgs = pluginMcp.mcpServers?.["ratel-local"]?.args;
const expectedRuntime = `@ratel-ai/ratel-local@${String(packageJson.version)}`;
if (!Array.isArray(pluginArgs) || !pluginArgs.includes(expectedRuntime)) {
  throw new Error(`plugin/.mcp.json must pin the runtime to ${expectedRuntime}`);
}

const runtimePinPattern =
  /@ratel-ai\/ratel-local@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g;
for (const documentationPath of [
  "../../README.md",
  "plugin/README.md",
  "plugin/skills/ratel-local/SKILL.md",
]) {
  const documentation = await readFile(resolve(appRoot, documentationPath), "utf8");
  const pins = [...documentation.matchAll(runtimePinPattern)].map((match) => match[1]);
  if (pins.length === 0) {
    throw new Error(`${documentationPath} must contain at least one published runtime pin`);
  }
  const stalePins = pins.filter((version) => version !== packageJson.version);
  if (stalePins.length > 0) {
    throw new Error(
      `${documentationPath} contains stale runtime version(s) ${[...new Set(stalePins)].join(", ")}; expected ${String(packageJson.version)}`,
    );
  }
}

const rootReadme = await readFile(resolve(appRoot, "../../README.md"), "utf8");
const trackedVersion = /This README tracks the `([^`]+)`/.exec(rootReadme)?.[1];
if (trackedVersion !== packageJson.version) {
  throw new Error(
    `../../README.md tracks version ${trackedVersion ?? "(missing)"}; expected ${String(packageJson.version)}`,
  );
}

await mustExist(resolve(dist, "bin.js"));
await mustExist(resolve(dist, "index.js"));
await mustExist(resolve(dist, "index.d.ts"));
await mustExist(resolve(dist, "ui/index.html"));

const bin = await readFile(resolve(dist, "bin.js"), "utf8");
if (!bin.startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/bin.js is missing the node shebang");
}

const uiAssets = await readdir(resolve(dist, "ui/assets")).catch(() => []);
if (uiAssets.length === 0) {
  throw new Error("dist/ui/assets is empty");
}

for (const file of await listFiles(dist)) {
  if (extname(file) !== ".js") continue;
  const text = await readFile(file, "utf8");
  if (text.includes("@ratel-ai/ratel-local-core")) {
    throw new Error(`${file} contains an unresolved @ratel-ai/ratel-local-core import`);
  }
}

async function mustExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing required package artifact: ${path}`);
  }
}

async function readJson<T = { version?: unknown }>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(path)));
    } else if ((await stat(path)).isFile()) {
      out.push(path);
    }
  }
  return out;
}
