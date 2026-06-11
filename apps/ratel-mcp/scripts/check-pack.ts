import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");

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
  if (text.includes("@ratel-ai/mcp-core")) {
    throw new Error(`${file} contains an unresolved @ratel-ai/mcp-core import`);
  }
}

async function mustExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing required package artifact: ${path}`);
  }
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
