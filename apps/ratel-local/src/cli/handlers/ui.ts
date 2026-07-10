import { openBrowser } from "../../ui/open-browser.js";
import { newSessionToken } from "../../ui/security.js";
import { startUiServer } from "../../ui/server.js";
import type { ParsedArgs } from "../args.js";
import type { HandlerCtx } from "./types.js";

export interface RunUiResult {
  shutdown: () => Promise<void>;
}

export async function runUi(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: { open?: typeof openBrowser } = {},
): Promise<RunUiResult> {
  const portFlag = parsed.flags.port;
  const port = parsePort(portFlag);
  const noOpen = parsed.flags.open === false;

  const token = newSessionToken();
  const handle = await startUiServer({ ctx, token, port });
  log(`[ratel] UI running at ${handle.url}`);
  log("[ratel] Press Ctrl-C to stop.");

  if (!noOpen) {
    (opts.open ?? openBrowser)(handle.url);
  }

  return { shutdown: handle.shutdown };
}

function parsePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === true || raw === false) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got "${raw}"`);
  }
  return n;
}
