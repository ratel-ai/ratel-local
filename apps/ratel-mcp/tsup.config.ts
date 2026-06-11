import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    bin: "src/bin.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  noExternal: ["@ratel-ai/mcp-core"],
  external: [
    "@clack/prompts",
    "@modelcontextprotocol/sdk",
    "@ratel-ai/sdk",
    "proper-lockfile",
    "smol-toml",
  ],
});
