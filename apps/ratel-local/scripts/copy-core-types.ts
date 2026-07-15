import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const coreDist = resolve(repoRoot, "packages/core/dist");
const target = resolve(appRoot, "dist/core");

await mkdir(resolve(appRoot, "dist"), { recursive: true });
await rm(target, { recursive: true, force: true });
for (const file of await listDeclarationFiles(coreDist)) {
  const dest = resolve(target, relative(coreDist, file));
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(file, dest);
}
await writeFile(resolve(appRoot, "dist/index.d.ts"), 'export * from "./core/index.js";\n');

async function listDeclarationFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listDeclarationFiles(path)));
      continue;
    }
    if (entry.isFile() && (path.endsWith(".d.ts") || path.endsWith(".d.ts.map"))) {
      out.push(path);
    }
  }
  return out;
}
