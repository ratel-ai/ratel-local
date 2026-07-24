import { join } from "node:path";
import {
  createConfigControlPlane,
  createContextSnapshotResolver,
  createLocalGitExcludeManager,
  createMutationEngine,
  createPreparedChangeCoordinator,
  createProjectAdmissionLock,
  createProjectRegistry,
  createSkillDiscovery,
  createSkillImportControlPlane,
  createSkillRegistrationControlPlane,
} from "@ratel-ai/ratel-local-core";
import { openBrowser } from "../../ui/open-browser.js";
import { newSessionToken } from "../../ui/security.js";
import { startUiServer } from "../../ui/server.js";
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
  const portFlag = parsed.flags.port;
  const port = parsePort(portFlag);
  const noOpen = parsed.flags.open === false;
  if (portFlag === undefined) {
    const daemonRequest =
      opts.daemonRequest ?? ((path, init) => requestRunningDaemon(ctx, path, init));
    const response = await daemonRequest("/api/ui/sessions", { method: "POST" });
    if (response) {
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
  }

  const projectRegistry = createProjectRegistry({ homeDir: ctx.env.homeDir });
  const projectAdmissionLock = createProjectAdmissionLock({
    controlDir: join(ctx.env.homeDir, ".ratel"),
  });
  const snapshotResolver = createContextSnapshotResolver({
    homeDir: ctx.env.homeDir,
    projectRegistry,
  });
  const preparedChanges =
    ctx.preparedChanges ??
    createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({
        controlDir: join(ctx.env.homeDir, ".ratel"),
      }),
    });
  const localGitExcludeManager = createLocalGitExcludeManager();
  const configControlPlane = await createConfigControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry,
    preparedChanges,
    localGitExcludeManager,
  });
  const skillDiscovery = createSkillDiscovery({
    homeDir: ctx.env.homeDir,
    registeredProjectRoots: async () =>
      (await projectRegistry.list())
        .filter((project) => project.status === "available")
        .map((project) => project.canonicalRoot),
  });
  const skillImportControlPlane = createSkillImportControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry,
    discovery: skillDiscovery,
    preparedChanges,
    localGitExcludeManager,
  });
  const skillRegistrationControlPlane = createSkillRegistrationControlPlane({
    homeDir: ctx.env.homeDir,
    projectRegistry,
    configControlPlane,
    snapshotResolver,
    preparedChanges,
    localGitExcludeManager,
  });

  const token = newSessionToken();
  const handle = await startUiServer({
    ctx,
    token,
    port,
    projectRegistry,
    projectAdmissionLock,
    configControlPlane,
    snapshotResolver,
    skillDiscovery,
    skillImportControlPlane,
    skillRegistrationControlPlane,
    preparedChanges,
  });
  log("[ratel] standalone UI: live daemon client and gateway state is unavailable");
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
