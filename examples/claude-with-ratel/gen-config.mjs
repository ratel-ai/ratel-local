import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start) {
  let dir = start;
  while (dir !== "/") {
    if (existsSync(resolve(dir, "package.json"))) {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
      if (pkg.name === "@ratel-ai/ratel-local") return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root (no @ratel-ai/ratel-local package.json above this folder)");
}

const repoRoot = findRepoRoot(here);
const template = readFileSync(resolve(here, "claude-with-ratel.template.json"), "utf8");
const resolved = template.replaceAll("<REPO_ROOT>", repoRoot);
writeFileSync(resolve(here, "claude-with-ratel.json"), resolved);
console.error(`wrote claude-with-ratel.json (REPO_ROOT=${repoRoot})`);
