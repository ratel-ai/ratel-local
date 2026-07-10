import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const uiDist = resolve(repoRoot, "packages/ui/dist");
const target = resolve(appRoot, "dist/ui");

await rm(target, { recursive: true, force: true });
await cp(uiDist, target, { recursive: true });
