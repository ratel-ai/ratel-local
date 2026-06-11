import type { ServerEntry } from "./lib/index.js";
import type { ResolvedBin } from "./locate-bin.js";

const GATEWAY_ENTRY_NAMES = new Set(["ratel", "ratel-mcp"]);
const DEFAULT_GATEWAY_ENTRY_NAME = "ratel-mcp";

export interface RatelGatewayEntry {
  name: typeof DEFAULT_GATEWAY_ENTRY_NAME;
  entry: ServerEntry;
}

export function makeRatelGatewayEntry(input: {
  bin: ResolvedBin;
  configPaths: string[];
}): RatelGatewayEntry {
  const args = input.configPaths.flatMap((path) => ["--config", path]);
  return {
    name: DEFAULT_GATEWAY_ENTRY_NAME,
    entry: {
      type: "stdio",
      command: input.bin.command,
      args: [...input.bin.args, "serve", ...args],
    },
  };
}

export function isRatelGatewayEntry(name: string, _entry: ServerEntry): boolean {
  return GATEWAY_ENTRY_NAMES.has(name);
}
