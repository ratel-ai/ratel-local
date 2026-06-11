import { cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");

for (const file of ["README.md", "LICENSE.md", "CHANGELOG.md"]) {
  await cp(resolve(repoRoot, file), resolve(appRoot, file));
}
