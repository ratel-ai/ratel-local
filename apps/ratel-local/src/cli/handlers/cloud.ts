import { resolveScope } from "@ratel-ai/ratel-local-core";
import { scanCloudProfileScopes } from "../../cloud/inventory.js";
import {
  CLOUD_PROFILE_ENV,
  type CloudSettings,
  CloudSettingsStore,
  type CloudSettingsStoreLike,
  cloudEndpoints,
  cloudSettingsPath,
  legacyCloudSettingsPath,
} from "../../cloud/settings.js";
import { ArgError } from "../args.js";
import type { CliCloudMutator, HandlerCtx } from "./types.js";

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
  store?: CloudSettingsStoreLike;
  /** Writes `cloud.profile` into a scoped config, with a backup. */
  mutateCloud?: CliCloudMutator;
  /** Daemon environment, for the profile `RATEL_PROFILE` selects. */
  processEnv?: NodeJS.ProcessEnv;
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
      ctx.log,
    );
  const settings = (await store.load()) ?? { profiles: {} };

  if (verb === "add") return add(ctx, store, settings);
  if (verb === "use") return use(ctx, settings, dependencies);
  if (verb === "list") return list(ctx, settings, dependencies.processEnv ?? process.env);
  throw new ArgError(`unknown cloud verb: ${verb}`);
}

async function add(
  ctx: HandlerCtx,
  store: NonNullable<CloudHandlerDependencies["store"]>,
  settings: CloudSettings,
): Promise<void> {
  const profile = profileArgument(ctx);
  // Asked before prompting: the adapter answers EOF with the cancel it also
  // uses for Ctrl-C, so afterwards a pipe and a deliberate abort look alike.
  if (!ctx.prompts.canPrompt()) {
    throw new ArgError(
      `cannot read a key for "${profile}" without a terminal. Run "ratel-local cloud add ${profile}" from an interactive shell.`,
    );
  }
  const entered = await ctx.prompts.password({
    message: `Paste the Ratel Cloud API key for "${profile}"`,
    mask: "•",
  });
  if (ctx.prompts.isCancel(entered)) {
    ctx.prompts.cancel("no API key was stored");
    return;
  }
  const apiKey = typeof entered === "string" ? entered.trim() : "";
  if (!apiKey) throw new ArgError(`no API key was entered for "${profile}".`);

  const next: CloudSettings = {
    ...settings,
    // The first profile stored becomes the default, so a single-project setup
    // never has to think about selection at all.
    default: settings.default ?? profile,
    profiles: { ...settings.profiles, [profile]: { apiKey } },
  };
  await store.save(next);
  ctx.log(`Stored the Ratel Cloud key for "${profile}".`);
  if (next.default === profile) {
    ctx.log(`"${profile}" is the default profile.`);
  } else {
    ctx.log(`Select it with: ratel-local cloud use ${profile}`);
  }
}

async function use(
  ctx: HandlerCtx,
  settings: CloudSettings,
  dependencies: CloudHandlerDependencies,
): Promise<void> {
  const profile = profileArgument(ctx);
  if (!settings.profiles[profile]) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new ArgError(
      `no Cloud profile named "${profile}"; stored profiles: ${known}. Add one with: ratel-local cloud add ${profile}`,
    );
  }
  if (!dependencies.mutateCloud) throw new Error("cloud use requires a config mutator");
  const scope = resolveScope(ctx.argv.flags.scope ?? "project");
  const { path } = await dependencies.mutateCloud({ scope, profile });
  ctx.log(`Selected "${profile}" for this ${scope} scope (${path}).`);
  ctx.log("Reconnect the agent to apply it.");
}

async function list(
  ctx: HandlerCtx,
  settings: CloudSettings,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const names = Object.keys(settings.profiles).sort();
  if (names.length === 0) {
    ctx.log("No Cloud profiles stored. Add one with: ratel-local cloud add <profile>");
    return;
  }
  const selected = env[CLOUD_PROFILE_ENV];
  const scopes = await scanCloudProfileScopes(ctx);
  for (const scope of scopes.unreadable) {
    ctx.log(`warning: ignoring ${scope.path}: ${scope.message}`);
  }
  const scoped = scopes.selected;
  for (const name of names) {
    const marks = [
      name === settings.default ? "default" : "",
      name === selected ? `${CLOUD_PROFILE_ENV}` : "",
      name === scoped?.profile ? "cloud.profile" : "",
    ].filter(Boolean);
    ctx.log(`${name}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`);
  }
  for (const [signal, url] of Object.entries(cloudEndpoints(settings))) {
    const overridden = settings[`${signal}Endpoint` as keyof CloudSettings] !== undefined;
    const source = overridden ? `${signal}Endpoint` : settings.baseUrl ? "baseUrl" : "default";
    ctx.log(`${signal.padEnd(8)}${url.toString().padEnd(46)}${source}`);
  }

  // The `RATEL_API_KEY` pair outranks all of these, but it lives in the daemon's
  // environment, which this process cannot see.
  const resolved = selected
    ? { profile: selected, source: CLOUD_PROFILE_ENV }
    : scoped
      ? { profile: scoped.profile, source: `cloud.profile in ${scoped.path}` }
      : settings.default
        ? { profile: settings.default, source: "store default" }
        : undefined;
  if (!resolved) {
    ctx.log("Cloud skills here: no profile resolves.");
    return;
  }
  ctx.log(`Cloud skills here: "${resolved.profile}" (${resolved.source})`);
  if (!settings.profiles[resolved.profile]) {
    ctx.log(`  warning: no profile named "${resolved.profile}" is stored, so nothing resolves.`);
  }
  if (scoped && !selected) {
    ctx.log('  Traces do not follow cloud.profile; run "ratel-local traces status".');
  }
}

function profileArgument(ctx: HandlerCtx): string {
  const profile = ctx.argv.rest[0];
  if (!profile || profile.startsWith("-")) {
    throw new ArgError(`cloud ${ctx.argv.verb} requires a profile name`);
  }
  return profile;
}
