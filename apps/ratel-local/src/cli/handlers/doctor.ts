import { join } from "node:path";
import {
  createContextSnapshotResolver,
  createMutationEngine,
  createProjectRegistry,
  InvalidContextSnapshotError,
  inventoryLegacyOAuthStores,
  type ResolvedContextSnapshot,
  type RuntimeContextRef,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "./types.js";

export class DoctorFailure extends Error {
  constructor(
    readonly issueCount: number,
    options?: ErrorOptions,
  ) {
    super(
      `doctor found ${issueCount} ${issueCount === 1 ? "issue" : "issues"} requiring intervention`,
      options,
    );
    this.name = "DoctorFailure";
  }
}

export async function runDoctor(ctx: HandlerCtx): Promise<void> {
  const controlDir = join(ctx.env.homeDir, ".ratel");
  try {
    await createMutationEngine({ controlDir });
  } catch (error) {
    ctx.log(
      `[error] mutation_recovery_failed: ${(error as Error).message}. Action: inspect ${join(controlDir, "transactions")} and repair or restore the reported journal before retrying.`,
    );
    throw new DoctorFailure(1, { cause: error });
  }
  ctx.log("[ok] mutation_recovery: transaction recovery completed");

  const registry = createProjectRegistry({ homeDir: ctx.env.homeDir });
  const resolver = createContextSnapshotResolver({
    homeDir: ctx.env.homeDir,
    projectRegistry: registry,
  });
  const snapshots: ResolvedContextSnapshot[] = [];
  let issueCount = 0;
  const resolveContext = async (
    context: RuntimeContextRef,
    label: string,
    successMessage: string,
  ): Promise<void> => {
    try {
      const snapshot = await resolver.resolve(context);
      snapshots.push(snapshot);
      for (const diagnostic of snapshot.diagnostics) {
        ctx.log(`[${diagnostic.severity}] ${diagnostic.code} [${label}]: ${diagnostic.message}`);
        if (diagnostic.severity === "error") issueCount += 1;
      }
      ctx.log(`[ok] ${successMessage}`);
    } catch (error) {
      if (error instanceof InvalidContextSnapshotError) {
        for (const diagnostic of error.diagnostics) {
          ctx.log(`[${diagnostic.severity}] ${diagnostic.code} [${label}]: ${diagnostic.message}`);
          if (diagnostic.severity === "error") issueCount += 1;
        }
        return;
      }
      issueCount += 1;
      ctx.log(`[error] context_resolution_failed [${label}]: ${(error as Error).message}`);
    }
  };
  await resolveContext({ kind: "global" }, "global", "context_global: resolved global context");

  let projects: Awaited<ReturnType<typeof registry.list>> = [];
  try {
    projects = await registry.list();
  } catch (error) {
    issueCount += 1;
    ctx.log(
      `[error] project_registry_invalid: ${(error as Error).message}. Action: inspect ${join(controlDir, "projects.json")} and restore valid versioned project data.`,
    );
  }
  for (const project of projects) {
    if (project.status === "missing") {
      issueCount += 1;
      ctx.log(
        `[error] project_missing: project ${project.id} root is unavailable: ${project.canonicalRoot}. Action: restore the root or remove the registration.`,
      );
      continue;
    }
    await resolveContext(
      {
        kind: "project",
        projectId: project.id,
      },
      `project:${project.id}`,
      `context_project: resolved project ${project.id} (${project.canonicalRoot})`,
    );
  }

  let oauth: Awaited<ReturnType<typeof inventoryLegacyOAuthStores>>;
  try {
    oauth = await inventoryLegacyOAuthStores({
      homeDir: ctx.env.homeDir,
      entries: snapshots.flatMap(({ mcpEntries }) => mcpEntries),
    });
  } catch (error) {
    issueCount += 1;
    ctx.log(
      `[error] legacy_oauth_inventory_failed: ${(error as Error).message}. Action: inspect ${join(controlDir, "oauth")} and repair its type, permissions, or contents before retrying.`,
    );
    throw new DoctorFailure(issueCount, { cause: error });
  }
  for (const item of oauth.ready) {
    ctx.log(
      `[info] legacy_oauth_migration_ready [oauth:${item.serverName}]: legacy OAuth state can be migrated to ${item.target.path} when daemon starts; no files were changed.`,
    );
  }
  for (const diagnostic of oauth.diagnostics) {
    const action = diagnostic.requiresReauthentication
      ? `re-authenticate "${diagnostic.serverName}" in the intended scope; legacy state was not changed.`
      : `inspect ${diagnostic.legacyPath} and its scoped destination; no files were changed.`;
    ctx.log(
      `[${diagnostic.severity}] ${diagnostic.code} [oauth:${diagnostic.serverName}]: ${diagnostic.message}. Action: ${action}`,
    );
    issueCount += 1;
  }
  if (issueCount > 0) throw new DoctorFailure(issueCount);
  ctx.log(
    `doctor: ok (${snapshots.length} ${snapshots.length === 1 ? "context" : "contexts"} checked)`,
  );
}
