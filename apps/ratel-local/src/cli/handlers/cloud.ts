import { resolveScope } from "@ratel-ai/ratel-local-core";
import {
  CloudCatalogAuthError,
  CloudCatalogProtocolError,
  CloudCatalogUnavailableError,
  createCloudCatalogLoader,
} from "../../cloud/catalog.js";
import { scanCloudProfileScopes } from "../../cloud/inventory.js";
import {
  type CloudSettings,
  CloudSettingsStore,
  type CloudSettingsStoreLike,
  cloudEndpoints,
  cloudSettingsPath,
} from "../../cloud/settings.js";
import { ArgError } from "../args.js";
import type { CliCloudMutator, HandlerCtx } from "./types.js";

export const CLOUD_USAGE = `usage: ratel-local cloud <verb> [args...]

Verbs:
  add <profile>     store a Ratel Cloud API key under a profile name
  use <profile>     select the profile this scope uses
  list              show stored profiles and which one resolves here
  status            show the profile this directory resolves to
  test <profile>    check that a stored profile can reach the catalog
  remove <profile>  delete a stored profile

Options:
  --scope user|project|local   where \`cloud use\` writes (default: project)
  --force                      remove even when this directory still selects it

Keys are stored in ~/.ratel/cloud.json, readable only by you, and never in a
repository. A project selects one by name, which is safe to commit.`;

export interface CloudHandlerDependencies {
  store?: CloudSettingsStoreLike;
  /** Writes `cloud.profile` into a scoped config, with a backup. */
  mutateCloud?: CliCloudMutator;
  /** Injected by tests; the CLI uses the global `fetch`. */
  fetch?: typeof fetch;
}

export async function runCloud(
  ctx: HandlerCtx,
  dependencies: CloudHandlerDependencies = {},
): Promise<void> {
  const verb = ctx.argv.verb;
  const store = dependencies.store ?? new CloudSettingsStore(cloudSettingsPath(ctx.env.homeDir));
  const settings = (await store.load()) ?? { profiles: {} };

  if (verb === "add") return add(ctx, store, settings);
  if (verb === "use") return use(ctx, settings, dependencies);
  if (verb === "list") return list(ctx, settings);
  if (verb === "status") return status(ctx, settings);
  if (verb === "test") return test(ctx, settings, dependencies);
  if (verb === "remove") return remove(ctx, store, settings);
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

async function list(ctx: HandlerCtx, settings: CloudSettings): Promise<void> {
  const names = Object.keys(settings.profiles).sort();
  if (names.length === 0) {
    ctx.log("No Cloud profiles stored. Add one with: ratel-local cloud add <profile>");
    return;
  }
  const scopes = await scanCloudProfileScopes(ctx);
  for (const scope of scopes.unreadable) {
    ctx.log(`warning: ignoring ${scope.path}: ${scope.message}`);
  }
  const scoped = scopes.selected;
  for (const name of names) {
    const marks = [
      name === settings.default ? "default" : "",
      name === scoped?.profile ? "cloud.profile" : "",
    ].filter(Boolean);
    ctx.log(`${name}${marks.length > 0 ? `  (${marks.join(", ")})` : ""}`);
  }
  ctx.log(
    `catalog ${cloudEndpoints(settings).catalog.toString().padEnd(46)}${catalogSourceOf(settings)}`,
  );

  // The `RATEL_API_KEY` pair outranks all of these, but it lives in the daemon's
  // environment, which this process cannot see.
  const resolved = resolveHere(settings, scoped);
  if (!resolved) {
    ctx.log("Cloud skills here: no profile resolves.");
    return;
  }
  ctx.log(`Cloud skills here: "${resolved.profile}" (${resolved.source})`);
  if (!settings.profiles[resolved.profile]) {
    ctx.log(`  warning: no profile named "${resolved.profile}" is stored, so nothing resolves.`);
  }
  ctx.log('  Traces use their own key; run "ratel-local traces status".');
}

async function status(ctx: HandlerCtx, settings: CloudSettings): Promise<void> {
  const scopes = await scanCloudProfileScopes(ctx);
  for (const scope of scopes.unreadable) {
    ctx.log(`warning: ignoring ${scope.path}: ${scope.message}`);
  }
  const resolved = resolveHere(settings, scopes.selected);
  const catalogSource = catalogSourceOf(settings);
  ctx.log(`catalog ${cloudEndpoints(settings).catalog.toString().padEnd(46)}${catalogSource}`);
  if (!resolved) {
    ctx.log("state none");
    ctx.log("No Cloud profile resolves here. Add one with: ratel-local cloud add <profile>");
    return;
  }
  if (!settings.profiles[resolved.profile]) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new ArgError(
      `${resolved.source} selects Cloud profile "${resolved.profile}", which is not stored; stored profiles: ${known}. Add one with: ratel-local cloud add ${resolved.profile}`,
    );
  }
  ctx.log(`profile "${resolved.profile}"`);
  ctx.log(`source ${resolved.source}`);
  ctx.log("state ready");
}

async function test(
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
  const catalog = cloudEndpoints(settings).catalog.toString();
  ctx.log(`profile "${profile}"`);
  ctx.log(`catalog ${catalog}`);
  const loader = createCloudCatalogLoader({
    endpoint: catalog,
    apiKey: settings.profiles[profile].apiKey,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  try {
    await loader.load();
  } catch (error) {
    if (error instanceof CloudCatalogAuthError) {
      ctx.log("reachable yes");
      ctx.log(`authorized no (${error.message})`);
      throw new ArgError(`credential rejected: ${error.message}`);
    }
    if (error instanceof CloudCatalogUnavailableError) {
      ctx.log("reachable no");
      ctx.log("authorized unknown");
      throw new ArgError(`catalog unreachable: ${error.message}`);
    }
    if (error instanceof CloudCatalogProtocolError) {
      ctx.log("reachable yes");
      ctx.log("authorized yes");
      throw new ArgError(`catalog malformed: ${error.message}`);
    }
    throw error;
  }
  ctx.log("reachable yes");
  ctx.log("authorized yes");
}

async function remove(
  ctx: HandlerCtx,
  store: NonNullable<CloudHandlerDependencies["store"]>,
  settings: CloudSettings,
): Promise<void> {
  const profile = profileArgument(ctx);
  if (!settings.profiles[profile]) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new ArgError(
      `no Cloud profile named "${profile}"; stored profiles: ${known}. Add one with: ratel-local cloud add ${profile}`,
    );
  }
  const force = ctx.argv.flags.force === true;
  const scopes = await scanCloudProfileScopes(ctx);
  const blockers = scopes.bindings.filter((binding) => binding.profile === profile);
  if (blockers.length > 0 && !force) {
    const files = blockers.map((binding) => binding.path).join(", ");
    throw new ArgError(
      `refusing to remove "${profile}" while ${files} still select it. This check covers this directory's user/project/local configs only, not every project on the machine. Rerun with --force to remove anyway, or change the selection with "ratel-local cloud use".`,
    );
  }
  const { [profile]: _removed, ...remaining } = settings.profiles;
  const clearedDefault = settings.default === profile;
  const next: CloudSettings = {
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.catalogEndpoint ? { catalogEndpoint: settings.catalogEndpoint } : {}),
    ...(!clearedDefault && settings.default ? { default: settings.default } : {}),
    profiles: remaining,
  };
  await store.save(next);
  ctx.log(`Removed Cloud profile "${profile}".`);
  if (clearedDefault) {
    ctx.log("The store default was cleared; no profile was promoted in its place.");
  }
  if (blockers.length > 0 && force) {
    ctx.log(
      `Note: ${blockers.map((b) => b.path).join(", ")} still name "${profile}"; this check only covers this directory.`,
    );
  }
}

function resolveHere(
  settings: CloudSettings,
  scoped: { profile: string; path: string } | undefined,
): { profile: string; source: string } | undefined {
  if (scoped) return { profile: scoped.profile, source: `cloud.profile in ${scoped.path}` };
  if (settings.default) return { profile: settings.default, source: "store default" };
  return undefined;
}

function catalogSourceOf(settings: CloudSettings): string {
  return settings.catalogEndpoint ? "catalogEndpoint" : settings.baseUrl ? "baseUrl" : "default";
}

function profileArgument(ctx: HandlerCtx): string {
  const profile = ctx.argv.rest[0];
  if (!profile || profile.startsWith("-")) {
    throw new ArgError(`cloud ${ctx.argv.verb} requires a profile name`);
  }
  return profile;
}
