import { openBrowser } from "../../ui/open-browser.js";
import type { ParsedArgs } from "../args.js";
import { type DaemonApiRequest, requestRunningDaemon, requireDaemonJson } from "../daemon-api.js";
import type { HandlerCtx } from "./types.js";

export interface RunUiResult {
  shutdown: () => Promise<void>;
}

export async function runUi(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: { open?: typeof openBrowser; daemonRequest?: DaemonApiRequest } = {},
): Promise<RunUiResult> {
  if (parsed.flags.port !== undefined) {
    throw new Error(
      "`ratel-local ui --port` is no longer supported; configure the daemon port with `ratel-local setup --port <port>`",
    );
  }
  const noOpen = parsed.flags.open === false;
  const daemonRequest =
    opts.daemonRequest ?? ((path, init) => requestRunningDaemon(ctx, path, init));
  const response = await daemonRequest("/api/ui/sessions", { method: "POST" });
  if (!response) {
    throw new Error(
      "the Ratel daemon is not running; run `ratel-local setup` before opening the UI",
    );
  }
  const { url } = await requireDaemonJson<{ url: string }>(response, "open daemon UI");
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("open daemon UI returned an invalid session URL");
  }
  if (noOpen) {
    log(`[ratel] daemon UI session: ${url}`);
  } else {
    (opts.open ?? openBrowser)(url);
    log("[ratel] opened the persistent daemon UI");
  }
  return { shutdown: async () => {} };
}
