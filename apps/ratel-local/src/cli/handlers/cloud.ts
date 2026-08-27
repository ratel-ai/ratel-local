import { resolveScope } from "@ratel-ai/ratel-local-core";
import {
  CLOUD_PROFILE_ENV,
  type CloudSettings,
  CloudSettingsStore,
  cloudSettingsPath,
  legacyCloudSettingsPath,
} from "../../cloud/settings.js";
import { ArgError } from "../args.js";
import type { HandlerCtx } from "./types.js";

export const CLOUD_USAGE = `usage: ratel-local cloud <verb> [args...]

Verbs:
  add <profile>     store a Ratel Cloud API key under a profile name
  use <profile>     select the profile this scope uses
  list              show stored profiles and which one resolves here

Options:
  --scope user|project|local   where \`cloud use\` writes (default: project)

Keys are stored in ~/.ratel/cloud.json, readable only by you, and never in a
repository. A project selects one by name, which is safe to commit.`;

export interface CloudHandlerDependencies {
  store?: { load(): Promise<CloudSettings | undefined>; save(s: CloudSettings): Promise<void> };
  /** Tells a running daemon to adopt the new key without a restart. */
  notifyDaemon?: (settings: CloudSettings) => Promise<void>;
}

export async function runCloud(
  ctx: HandlerCtx,
  dependencies: CloudHandlerDependencies = {},
): Promise<void> {
  const verb = ctx.argv.verb;
  const store =
    dependencies.store ??
    new CloudSettingsStore(
      cloudSettingsPath(ctx.env.homeDir),
      legacyCloudSettingsPath(ctx.env.homeDir),
    );
  const settings = (await store.load()) ?? {
    tracesEndpoint: DEFAULT_TRACES_ENDPOINT,
    profiles: {},
  };

  if (verb === "add") return add(ctx, store, settings, dependencies);
  if (verb === "use") return use(ctx, settings);
  if (verb === "list") return list(ctx, settings);
  throw new ArgError(`unknown cloud verb: ${verb}`);
}

const DEFAULT_TRACES_ENDPOINT = "https://cloud.ratel.sh/api/v1/traces";

async function add(
  ctx: HandlerCtx,
  store: NonNullable<CloudHandlerDependencies["store"]>,
  settings: CloudSettings,
  dependencies: CloudHandlerDependencies,
): Promise<void> {
  const profile = profileArgument(ctx);
  const entered = await ctx.prompts.password({
    message: `Paste the Ratel Cloud API key for "${profile}"`,
    mask: "•",
  });
  if (ctx.prompts.isCancel(entered) || typeof entered !== "string" || entered.trim() === "") {
    ctx.prompts.cancel("no API key was stored");
    return;
  }

  const next: CloudSettings = {
    ...settings,
    // The first profile stored becomes the default, so a single-project setup
    // never has to think about selection at all.
    default: settings.default ?? profile,
    profiles: { ...settings.profiles, [profile]: { apiKey: entered.trim() } },
  };
  await store.save(next);
  ctx.log(`Stored the Ratel Cloud key for "${profile}".`);
  if (next.default === profile && Object.keys(next.profiles).length === 1) {
    ctx.log(`"${profile}" is the default profile.`);
  } else {
    ctx.log(`Select it with: ratel-local cloud use ${profile}`);
  }
  await dependencies.notifyDaemon?.(next);
}

function use(ctx: HandlerCtx, settings: CloudSettings): void {
  const profile = profileArgument(ctx);
  if (!settings.profiles[profile]) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new ArgError(
      `no Cloud profile named "${profile}"; stored profiles: ${known}. Add one with: ratel-local cloud add ${profile}`,
    );
  }
  const scope = resolveScope(ctx.argv.flags.scope ?? "project");
  ctx.log(`Add this to your ${scope} config to select it:`);
  ctx.log(JSON.stringify({ cloud: { profile } }, null, 2));
}

function list(ctx: HandlerCtx, settings: CloudSettings): void {
  const names = Object.keys(settings.profiles).sort();
  if (names.length === 0) {
    ctx.log("No Cloud profiles stored. Add one with: ratel-local cloud add <profile>");
    return;
  }
  const selected = process.env[CLOUD_PROFILE_ENV];
  for (const name of names) {
    const marks = [
      name === settings.default ? "default" : "",
      name === selected ? `${CLOUD_PROFILE_ENV}` : "",
    ].filter(Boolean);
    ctx.log(`${name}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`);
  }
  ctx.log(`Endpoint: ${settings.tracesEndpoint}`);
}

function profileArgument(ctx: HandlerCtx): string {
  const profile = ctx.argv.rest[0];
  if (!profile || profile.startsWith("-")) {
    throw new ArgError(`cloud ${ctx.argv.verb} requires a profile name`);
  }
  return profile;
}
