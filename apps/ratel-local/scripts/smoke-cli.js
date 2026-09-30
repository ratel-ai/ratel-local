import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Run against an isolated installation of the packed package, never the user's daemon.
const installDir = resolve(process.argv[2] ?? ".");
const packageDir = join(installDir, "node_modules/@ratel-ai/ratel-local");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
assert.equal(pkg.name, "@ratel-ai/ratel-local");
assert.deepEqual(pkg.bin, { ratel: "./dist/bin.js", "ratel-local": "./dist/bin.js" });

function invoke(name, args) {
  const path = join(installDir, "node_modules/.bin", name);
  const windows = process.platform === "win32";
  const result = spawnSync(windows ? `"${path}.cmd"` : path, args, {
    cwd: installDir,
    env: { ...process.env, RATEL_TELEMETRY: "off" },
    shell: windows,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const [args, status, expected] of [
  [["--help"], 0, "usage: ratel <command>"],
  [["--version"], 0, pkg.version],
  [["version"], 0, pkg.version],
  [["mcp"], 0, "usage: ratel mcp"],
  [["setup", "--help"], 0, "usage: ratel setup"],
  [["daemon", "--help"], 0, "usage: ratel daemon"],
  [["unknown-command"], 1, "unknown command: unknown-command"],
  [["serve"], 1, "usage: ratel serve"],
]) {
  const primary = invoke("ratel", args);
  const alias = invoke("ratel-local", args);
  assert.deepEqual(alias, primary, `alias differs for ${args.join(" ")}`);
  assert.equal(primary.status, status);
  assert.ok((primary.stdout + primary.stderr).includes(expected));
}

// Both the explicit service runner and the historical package shorthand must work.
for (const args of [
  ["--offline", "--no-install", "--package", `${pkg.name}@${pkg.version}`, "ratel", "--version"],
  ["--offline", "--no-install", `${pkg.name}@${pkg.version}`, "--version"],
]) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd: installDir,
    env: {
      ...process.env,
      npm_config_cache: join(installDir, ".npm-cache"),
      npm_config_update_notifier: "false",
    },
    shell: process.platform === "win32",
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).trim(), pkg.version);
}

// Services reuse the installed JS entry point with the absolute Node executable.
const service = spawnSync(process.execPath, [join(packageDir, pkg.bin.ratel), "--version"], {
  encoding: "utf8",
  timeout: 15000,
});
assert.ifError(service.error);
assert.equal(service.status, 0);
assert.equal((service.stdout + service.stderr).trim(), pkg.version);
console.log(
  "Packed CLI smoke passed: both installed names, routing, exits, and service entry point.",
);
