import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGatewayFromConfig,
  type ConfigControlPlane,
  type ContextSnapshotResolver,
  createProjectRegistry,
  type DocumentRevision,
  documentRevision,
  InvalidContextSnapshotError,
  type MutationPlan,
  type ProjectAdmissionLock,
  type ProjectId,
  type ProjectRegistry,
  parseSkillMd,
  type RatelScopeRef,
  type RuntimeContextRef,
  readJson,
  type ServerEntry,
  type SkillDiscovery,
  type SkillImportControlPlane,
  type SkillImportPlan,
  type SkillImportSelection,
  type SkillRegistrationControlPlane,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "../cli/handlers/types.js";
import {
  addProjectRoute,
  type CanForgetProject,
  deleteProjectRoute,
  getProjectsRoute,
  type ProjectRouteDependencies,
} from "./project-routes.js";
import {
  type ActiveMcpClientReader,
  type ApiResponse,
  activateSkillsRoute,
  addServer,
  applyCombinedImport,
  applyImportAgent,
  applyImportRatel,
  applyLink,
  authServer,
  createSkillRoute,
  deactivateSkillsRoute,
  doImport,
  doLink,
  editServer,
  getAgentHosts,
  getConfig,
  getMcpClients,
  getSkill,
  getSkills,
  installClaudeStatuslineRoute,
  openFile,
  previewImport,
  previewLink,
  removeServer,
  repairAgentConnection,
  uninstallClaudeStatuslineRoute,
  updateSkillRoute,
} from "./routes.js";
import {
  extractBearer,
  extractTokenFromUrl,
  InMemoryUiSessionTokens,
  isLoopbackHost,
  UI_HOST,
} from "./security.js";

export interface StartUiServerOptions {
  ctx: HandlerCtx;
  token: string;
  port?: number;
  assetDir?: string;
  activeMcpClients?: ActiveMcpClientReader;
  sessionTokens?: InMemoryUiSessionTokens;
  projectRegistry?: ProjectRegistry;
  projectAdmissionLock?: ProjectAdmissionLock;
  configControlPlane?: ConfigControlPlane;
  snapshotResolver?: ContextSnapshotResolver;
  skillDiscovery?: SkillDiscovery;
  skillImportControlPlane?: SkillImportControlPlane;
  skillRegistrationControlPlane?: SkillRegistrationControlPlane;
  /** Long-lived local daemon credential used by CLI API clients. */
  daemonToken?: string;
  canForgetProject?: CanForgetProject;
  /** Awaited after a scoped commit so the daemon can publish fresh revisions. */
  onScopedMutationCommitted?: (targets: readonly RatelScopeRef[]) => void | Promise<void>;
  publicRoute?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
}

interface RequestHandlerOptions extends StartUiServerOptions {
  projectRegistry: ProjectRegistry;
  projectAware: boolean;
  sessionTokens: InMemoryUiSessionTokens;
  skillRegistrationPlanTargets: Map<string, RatelScopeRef>;
}

export interface UiServerHandle {
  url: string;
  port: number;
  shutdown(): Promise<void>;
}

export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const activeMcpClients = opts.activeMcpClients;
  const requestOptions: RequestHandlerOptions = {
    ...opts,
    projectAware: opts.projectRegistry !== undefined,
    sessionTokens: opts.sessionTokens ?? new InMemoryUiSessionTokens([opts.token]),
    skillRegistrationPlanTargets: new Map(),
    projectRegistry:
      opts.projectRegistry ?? createProjectRegistry({ homeDir: opts.ctx.env.homeDir }),
    canForgetProject:
      opts.canForgetProject ??
      (activeMcpClients
        ? (project) =>
            !activeMcpClients
              .listActiveClients()
              .some((client) => client.projectRoot === project.canonicalRoot)
        : undefined),
  };
  const server = createHttpServer((req, res) => {
    handleRequest(req, res, requestOptions).catch((err) => {
      writeJson(res, 500, { error: (err as Error).message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, UI_HOST, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://${UI_HOST}:${port}/?t=${opts.token}`;

  return {
    url,
    port,
    shutdown: () => closeServer(server),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RequestHandlerOptions,
): Promise<void> {
  const port = (req.socket.localPort as number | undefined) ?? 0;

  if (!isLoopbackHost(req.headers.host, port)) {
    writePlain(res, 400, "Invalid Host header");
    return;
  }

  const url = req.url ?? "/";
  const path = url.split("?")[0];
  const projectId = projectIdFromUrl(url);

  if (opts.publicRoute && (await opts.publicRoute(req, res, path))) {
    return;
  }

  if (req.method === "GET" && !path.startsWith("/api/")) {
    if (hasFileExtension(path)) {
      await writeStaticAsset(res, opts.assetDir ?? defaultUiAssetDir(), path);
      return;
    }

    const queryToken = extractTokenFromUrl(url);
    if (!queryToken || !opts.sessionTokens.isValid(queryToken)) {
      writePlain(res, 401, "Unauthorized");
      return;
    }
    await writeStaticAsset(res, opts.assetDir ?? defaultUiAssetDir(), "/index.html");
    return;
  }

  const bearer = extractBearer(req.headers.authorization);
  if (
    !bearer ||
    (!opts.sessionTokens.isValid(bearer) &&
      (opts.daemonToken === undefined || bearer !== opts.daemonToken))
  ) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    const requestContext = await contextForRequest(opts, projectId);
    const response = await route(
      req,
      path,
      requestContext.ctx,
      opts.activeMcpClients,
      {
        registry: opts.projectRegistry,
        canForgetProject: opts.canForgetProject,
        clients: opts.activeMcpClients,
        admissionLock: opts.projectAdmissionLock,
      },
      requestContext.runtimeContext,
      opts.configControlPlane,
      opts.snapshotResolver,
      opts.skillDiscovery,
      opts.skillImportControlPlane,
      opts.skillRegistrationControlPlane,
      opts.onScopedMutationCommitted,
      opts.skillRegistrationPlanTargets,
    );
    if (!response) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    writeJson(res, response.status, response.body);
  } catch (err) {
    writeJson(res, routeErrorStatus(err, opts.snapshotResolver ? 500 : 400), {
      error: (err as Error).message,
    });
  }
}

async function route(
  req: IncomingMessage,
  path: string,
  ctx: HandlerCtx,
  activeMcpClients?: ActiveMcpClientReader,
  projects?: ProjectRouteDependencies,
  runtimeContext: RuntimeContextRef = { kind: "global" },
  configControlPlane?: ConfigControlPlane,
  snapshotResolver?: ContextSnapshotResolver,
  skillDiscovery?: SkillDiscovery,
  skillImportControlPlane?: SkillImportControlPlane,
  skillRegistrationControlPlane?: SkillRegistrationControlPlane,
  onScopedMutationCommitted?: (targets: readonly RatelScopeRef[]) => void | Promise<void>,
  skillRegistrationPlanTargets: Map<string, RatelScopeRef> = new Map(),
): Promise<ApiResponse | null> {
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/config") {
    return getConfigWithSnapshot(ctx, runtimeContext, snapshotResolver);
  }
  if (method === "GET" && path === "/api/projects" && projects) {
    return getProjectsRoute(projects);
  }
  if (method === "POST" && path === "/api/projects" && projects) {
    const body = await readJsonBody(req);
    return addProjectRoute(projects, body);
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (method === "DELETE" && projectMatch && projects) {
    return deleteProjectRoute(projects, decodeURIComponent(projectMatch[1]));
  }
  if (method === "GET" && path === "/api/mcp-clients") {
    return getMcpClients(activeMcpClients, runtimeContext);
  }
  if (method === "GET" && path === "/api/agent-hosts") {
    return getAgentHosts(ctx);
  }
  if (method === "GET" && path === "/api/skills") {
    return getSkillsWithSnapshot(ctx, runtimeContext, snapshotResolver, skillDiscovery);
  }
  if (method === "POST" && path === "/api/skills/import/preview" && skillImportControlPlane) {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.selections)) {
      throw new UiRouteError(422, "selections must be an array");
    }
    const plan = await skillImportControlPlane.preview(
      body.selections as unknown as SkillImportSelection[],
    );
    return { status: 200, body: plan };
  }
  if (method === "POST" && path === "/api/skills/import/apply" && skillImportControlPlane) {
    const body = await readJsonBody(req);
    if (typeof body.plan !== "object" || body.plan === null || Array.isArray(body.plan)) {
      throw new UiRouteError(422, "plan must be an object returned by preview");
    }
    if (typeof body.digest !== "string" || body.digest.length === 0) {
      throw new UiRouteError(422, "digest is required");
    }
    const submittedPlan = body.plan as unknown as SkillImportPlan;
    const commit = await skillImportControlPlane.apply(submittedPlan, {
      digest: body.digest,
    });
    await onScopedMutationCommitted?.(
      submittedPlan.selections.flatMap((selection) =>
        selection.targets.map(({ scopeRef }) => scopeRef),
      ),
    );
    return { status: 200, body: commit };
  }
  if (
    method === "POST" &&
    path === "/api/skills/add-scope/preview" &&
    skillRegistrationControlPlane
  ) {
    const body = await readJsonBody(req);
    const target = parseRatelScopeRef(body.target);
    const id = requiredBodyString(body.id, "id");
    if (body.mode !== "reference" && body.mode !== "copy") {
      throw new UiRouteError(422, "mode must be reference or copy");
    }
    const plan = await skillRegistrationControlPlane.previewAddScope({
      context: runtimeContext,
      target,
      id,
      mode: body.mode,
    });
    skillRegistrationPlanTargets.set(plan.id, target);
    return { status: 200, body: plan };
  }
  if (
    method === "POST" &&
    path === "/api/skills/add-scope/apply" &&
    skillRegistrationControlPlane
  ) {
    const body = await readJsonBody(req);
    if (typeof body.plan !== "object" || body.plan === null || Array.isArray(body.plan)) {
      throw new UiRouteError(422, "plan must be an object returned by preview");
    }
    if (typeof body.digest !== "string" || body.digest.length === 0) {
      throw new UiRouteError(422, "digest is required");
    }
    const plan = body.plan as unknown as MutationPlan;
    const target = skillRegistrationPlanTargets.get(plan.id);
    if (!target) {
      throw new UiRouteError(
        409,
        "skill add-scope preview is unknown, expired, or already consumed",
      );
    }
    skillRegistrationPlanTargets.delete(plan.id);
    const commit = await skillRegistrationControlPlane.apply(plan, {
      digest: body.digest,
    });
    await onScopedMutationCommitted?.([target]);
    return { status: 200, body: commit };
  }
  if (method === "POST" && path === "/api/skills") {
    if (snapshotResolver) {
      throw new UiRouteError(422, "create a scoped owned copy through skill import");
    }
    const body = await readJsonBody(req);
    return createSkillRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/skills/activate") {
    if (snapshotResolver) {
      throw new UiRouteError(422, "legacy activation is disabled; use skill import preview/apply");
    }
    const body = await readJsonBody(req);
    return activateSkillsRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/skills/deactivate") {
    if (snapshotResolver) {
      throw new UiRouteError(422, "legacy deactivation is disabled; remove a scoped registration");
    }
    const body = await readJsonBody(req);
    return deactivateSkillsRoute(ctx, body);
  }
  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (skillMatch) {
    const id = decodeURIComponent(skillMatch[1]);
    if (method === "GET") {
      return snapshotResolver
        ? getResolvedSkill(snapshotResolver, runtimeContext, id)
        : getSkill(ctx, id);
    }
    if (method === "PATCH") {
      if (snapshotResolver) {
        if (!skillRegistrationControlPlane) {
          throw new UiRouteError(500, "scoped skill control plane is unavailable");
        }
        const body = await readJsonBody(req);
        const target = parseRatelScopeRef(body.target);
        const description = requiredBodyString(body.description, "description");
        const tags = stringArray(body.tags, "tags");
        if (typeof body.body !== "string") throw new UiRouteError(422, "body is required");
        const expectedRevision = optionalDocumentRevision(body.expectedRevision);
        const commit = await skillRegistrationControlPlane.edit({
          target,
          id,
          description,
          tags,
          body: body.body,
          ...(expectedRevision ? { expectedRevision } : {}),
        });
        await onScopedMutationCommitted?.([target]);
        return { status: 200, body: commit };
      }
      const body = await readJsonBody(req);
      return updateSkillRoute(ctx, id, body);
    }
    if (method === "DELETE" && skillRegistrationControlPlane) {
      const body = await readJsonBody(req);
      const target = parseRatelScopeRef(body.target);
      const commit = await skillRegistrationControlPlane.remove({
        target,
        id,
        deleteOwnedCopy: body.deleteOwnedCopy === true,
      });
      await onScopedMutationCommitted?.([target]);
      return { status: 200, body: commit };
    }
  }
  if (method === "POST" && path === "/api/open-file") {
    const body = await readJsonBody(req);
    return openFile(ctx, body);
  }
  if (method === "POST" && path === "/api/servers") {
    const body = await readJsonBody(req);
    if (configControlPlane) {
      const response = await mutateServerWithControlPlane(
        configControlPlane,
        "add",
        undefined,
        body,
      );
      await onScopedMutationCommitted?.([parseRatelScopeRef(body.target)]);
      return response;
    }
    return addServer(ctx, body);
  }

  const serverMatch = /^\/api\/servers\/([^/]+)$/.exec(path);
  if (serverMatch) {
    const name = decodeURIComponent(serverMatch[1]);
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      if (configControlPlane) {
        const response = await mutateServerWithControlPlane(configControlPlane, "edit", name, body);
        await onScopedMutationCommitted?.([parseRatelScopeRef(body.target)]);
        return response;
      }
      return editServer(ctx, name, body);
    }
    if (method === "DELETE") {
      const body = await readJsonBody(req);
      if (configControlPlane) {
        const response = await mutateServerWithControlPlane(
          configControlPlane,
          "remove",
          name,
          body,
        );
        await onScopedMutationCommitted?.([parseRatelScopeRef(body.target)]);
        return response;
      }
      return removeServer(ctx, name, body);
    }
  }

  const authMatch = /^\/api\/auth\/([^/]+)$/.exec(path);
  if (method === "POST" && authMatch) {
    const name = decodeURIComponent(authMatch[1]);
    return snapshotResolver
      ? authResolvedServer(snapshotResolver, runtimeContext, name)
      : authServer(ctx, name);
  }

  if (method === "POST" && path === "/api/import") {
    const response = await doImport(ctx);
    await onScopedMutationCommitted?.(mutationTargetsForContext(runtimeContext));
    return response;
  }
  if (method === "POST" && path === "/api/link") {
    return doLink(ctx);
  }
  if (method === "POST" && path === "/api/agent-preview/import") {
    const body = await readJsonBody(req);
    return previewImport(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-preview/link") {
    const body = await readJsonBody(req);
    return previewLink(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-apply/import/ratel") {
    const body = await readJsonBody(req);
    const response = await applyImportRatel(ctx, body);
    await onScopedMutationCommitted?.(mutationTargetsForContext(runtimeContext));
    return response;
  }
  if (method === "POST" && path === "/api/agent-apply/import") {
    const body = await readJsonBody(req);
    const response = await applyCombinedImport(ctx, body);
    await onScopedMutationCommitted?.(mutationTargetsForContext(runtimeContext));
    return response;
  }
  if (method === "POST" && path === "/api/agent-apply/import/agent") {
    const body = await readJsonBody(req);
    return applyImportAgent(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-apply/link") {
    const body = await readJsonBody(req);
    return applyLink(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-connection/repair") {
    const body = await readJsonBody(req);
    return repairAgentConnection(ctx, body);
  }
  if (method === "POST" && path === "/api/claude-statusline/install") {
    const body = await readJsonBody(req);
    return installClaudeStatuslineRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/claude-statusline/uninstall") {
    return uninstallClaudeStatuslineRoute(ctx);
  }
  return null;
}

function mutationTargetsForContext(context: RuntimeContextRef): RatelScopeRef[] {
  return context.kind === "global"
    ? [{ scope: "user" }]
    : [
        { scope: "user" },
        { scope: "project", projectId: context.projectId },
        { scope: "local", projectId: context.projectId },
      ];
}

async function getResolvedSkill(
  resolver: ContextSnapshotResolver,
  context: RuntimeContextRef,
  id: string,
): Promise<ApiResponse> {
  const snapshot = await resolver.resolve(context);
  const skill = snapshot.skills.effectiveSkills.find((candidate) => candidate.id === id);
  if (!skill) return { status: 404, body: { error: `unknown effective skill: ${id}` } };
  const registration = snapshot.skills.registrations.find(
    (candidate) => candidate.id === id && candidate.state === "effective",
  );
  let body = skill.body;
  let skillDocumentRevision: DocumentRevision | undefined;
  if (registration?.editable && registration.canonicalPath) {
    const skillPath = join(registration.canonicalPath, "SKILL.md");
    const raw = await readFile(skillPath);
    skillDocumentRevision = documentRevision(raw);
    body = parseSkillMd(raw.toString("utf8"), skillPath, id).body;
  }
  return {
    status: 200,
    body: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      body,
      state: "active",
      source: normalizedDiscoverySource(registration?.source ?? "ratel"),
      registration,
      editable: registration?.editable === true,
      ...(skillDocumentRevision ? { skillDocumentRevision } : {}),
    },
  };
}

async function authResolvedServer(
  resolver: ContextSnapshotResolver,
  context: RuntimeContextRef,
  name: string,
): Promise<ApiResponse> {
  const snapshot = await resolver.resolve(context);
  const resolved = snapshot.mcpEntries.find(
    (candidate) => candidate.status === "effective" && candidate.name === name,
  );
  if (!resolved) throw new UiRouteError(404, `unknown effective MCP server: ${name}`);
  const gateway = await buildGatewayFromConfig(
    { mcpServers: {} },
    {
      resolvedMcpEntries: snapshot.mcpEntries,
      resolvedSkills: snapshot.skills.effectiveSkills,
    },
  );
  try {
    const results = await gateway.runAuthFlow({ name });
    const failed = results.find(({ status }) => status === "failed" || status === "unsupported");
    if (failed) {
      throw new UiRouteError(
        422,
        `${failed.name} ${failed.status}${failed.reason ? `: ${failed.reason}` : ""}`,
      );
    }
    return {
      status: 200,
      body: {
        results,
        log: results.map(
          (result) => `${result.name} ${result.status}${result.reason ? `: ${result.reason}` : ""}`,
        ),
      },
    };
  } finally {
    await gateway.close();
  }
}

interface RequestContext {
  ctx: HandlerCtx;
  runtimeContext: RuntimeContextRef;
}

class UiRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UiRouteError";
  }
}

async function mutateServerWithControlPlane(
  control: ConfigControlPlane,
  action: "add" | "edit" | "remove",
  pathName: string | undefined,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const target = parseRatelScopeRef(body.target);
  const name = pathName ?? requiredBodyString(body.name, "name");
  const expectedRevision = optionalDocumentRevision(body.expectedRevision);
  const commit = await control.mutateServer({
    target,
    action,
    name,
    ...(action === "remove" ? {} : { entry: body.entry as ServerEntry }),
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  return {
    status: 200,
    body: {
      name,
      target,
      transactionId: commit.transactionId,
      changedPaths: commit.changedPaths,
      revisions: commit.revisions,
    },
  };
}

function parseRatelScopeRef(value: unknown): RatelScopeRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UiRouteError(422, "target must be a scoped object");
  }
  const target = value as Record<string, unknown>;
  if (target.scope === "user") return { scope: "user" };
  if (target.scope === "project" || target.scope === "local") {
    if (typeof target.projectId !== "string" || target.projectId.length === 0) {
      throw new UiRouteError(422, `${target.scope} target requires projectId`);
    }
    return { scope: target.scope, projectId: target.projectId as ProjectId };
  }
  throw new UiRouteError(422, "target.scope must be user|project|local");
}

function optionalDocumentRevision(value: unknown): DocumentRevision | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new UiRouteError(422, "expectedRevision must be a non-empty string");
  }
  return value as DocumentRevision;
}

function requiredBodyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new UiRouteError(422, `${name} is required`);
}

function stringArray(value: unknown, name: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new UiRouteError(422, `${name} must be an array of strings`);
}

function routeErrorStatus(error: unknown, unexpectedStatus = 400): number {
  if (error instanceof UiRouteError) return error.status;
  if (error instanceof InvalidContextSnapshotError) return 422;
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return unexpectedStatus;
}

async function getConfigWithSnapshot(
  ctx: HandlerCtx,
  context: RuntimeContextRef,
  resolver: ContextSnapshotResolver | undefined,
): Promise<ApiResponse> {
  const response = await getConfig(ctx);
  if (!resolver) return response;
  const snapshot = await resolver.resolve(context);
  const body = { ...(response.body as Record<string, unknown>) };
  const scopes = body.scopes as
    | Record<string, { authStatus?: Record<string, string> } | undefined>
    | undefined;
  if (scopes) {
    for (const resolved of snapshot.mcpEntries) {
      const scope = scopes[resolved.owner.scope];
      if (!scope) continue;
      scope.authStatus ??= {};
      scope.authStatus[resolved.name] = await scopedAuthStatus(ctx, resolved);
    }
  }
  return {
    status: response.status,
    body: {
      ...body,
      runtimeRevision: snapshot.runtimeRevision,
      documents: snapshot.documents,
      resolvedMcpEntries: snapshot.mcpEntries,
      diagnostics: snapshot.diagnostics,
    },
  };
}

async function scopedAuthStatus(
  ctx: HandlerCtx,
  resolved: Awaited<ReturnType<ContextSnapshotResolver["resolve"]>>["mcpEntries"][number],
): Promise<string> {
  if (resolved.entry.type !== "http" && resolved.entry.type !== "sse") return "n/a";
  const stored = await readJson<{
    tokens?: { access_token?: string };
    expires_at?: number;
    unsupported?: { reason?: string };
    resource_fingerprint?: string;
  }>(ctx.fs, resolved.oauthKey.path);
  if (
    stored?.resource_fingerprint &&
    stored.resource_fingerprint !== resolved.oauthKey.fingerprint
  ) {
    return "needs auth";
  }
  if (!stored?.tokens?.access_token)
    return stored?.unsupported?.reason ? "unsupported" : "needs auth";
  return typeof stored.expires_at === "number" && stored.expires_at < Date.now() ? "expired" : "ok";
}

async function getSkillsWithSnapshot(
  ctx: HandlerCtx,
  context: RuntimeContextRef,
  resolver: ContextSnapshotResolver | undefined,
  discovery: SkillDiscovery | undefined,
): Promise<ApiResponse> {
  const response = await getSkills(ctx);
  const snapshot = resolver ? await resolver.resolve(context) : undefined;
  const discovered = discovery
    ? await discovery.discover(
        context.kind === "global"
          ? { kind: "global" }
          : { kind: "project", projectRoot: requiredProjectRoot(ctx) },
      )
    : undefined;
  if (!snapshot && !discovered) return response;
  const responseBody = { ...(response.body as Record<string, unknown>) };
  if (discovered && Array.isArray(responseBody.available)) {
    responseBody.available = responseBody.available.map((value) => {
      if (typeof value !== "object" || value === null) return value;
      const skill = value as { id?: unknown; source?: unknown };
      const candidate = discovered.candidates.find(
        (item) => item.id === skill.id && normalizedDiscoverySource(item.source) === skill.source,
      );
      return candidate ? { ...skill, candidateId: candidate.candidateId } : skill;
    });
  }
  return {
    status: response.status,
    body: {
      ...responseBody,
      ...(snapshot
        ? {
            effectiveSkills: snapshot.skills.effectiveSkills,
            registrations: snapshot.skills.registrations,
            diagnostics: snapshot.skills.diagnostics,
            fingerprint: snapshot.skills.fingerprint,
            runtimeRevision: snapshot.runtimeRevision,
          }
        : {}),
      ...(discovered
        ? {
            discovered: discovered.candidates,
            discoveryDiagnostics: discovered.diagnostics,
            discovery: {
              visitedDirectories: discovered.visitedDirectories,
              truncated: discovered.truncated,
              timedOut: discovered.timedOut,
            },
          }
        : {}),
    },
  };
}

function normalizedDiscoverySource(source: string): "claude" | "codex" | "ratel" {
  if (source === "claude") return "claude";
  if (source === "codex-current" || source === "codex-legacy") return "codex";
  return "ratel";
}

function requiredProjectRoot(ctx: HandlerCtx): string {
  if (!ctx.env.projectRoot) throw new UiRouteError(409, "project root is unavailable");
  return ctx.env.projectRoot;
}

function projectIdFromUrl(url: string): ProjectId | undefined {
  const value = new URL(url, "http://127.0.0.1").searchParams.get("projectId");
  return value ? (value as ProjectId) : undefined;
}

async function contextForRequest(
  options: RequestHandlerOptions,
  projectId: ProjectId | undefined,
): Promise<RequestContext> {
  if (!options.projectAware) {
    return { ctx: options.ctx, runtimeContext: { kind: "global" } };
  }
  if (!projectId) {
    return {
      ctx: { ...options.ctx, env: { homeDir: options.ctx.env.homeDir } },
      runtimeContext: { kind: "global" },
    };
  }
  const project = (await options.projectRegistry.list()).find(({ id }) => id === projectId);
  if (!project) throw new UiRouteError(404, `unknown project: ${projectId}`);
  if (project.status === "missing") {
    throw new UiRouteError(409, `project root is missing: ${projectId}`);
  }
  return {
    ctx: {
      ...options.ctx,
      env: { homeDir: options.ctx.env.homeDir, projectRoot: project.canonicalRoot },
    },
    runtimeContext: { kind: "project", projectId: project.id },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) {
      throw new UiRouteError(422, "request body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UiRouteError(422, "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof UiRouteError) throw err;
    throw new UiRouteError(422, `invalid JSON body: ${(err as Error).message}`);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function defaultUiAssetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ui");
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").at(-1) ?? "";
  return last.includes(".");
}

async function writeStaticAsset(
  res: ServerResponse,
  assetDir: string,
  requestPath: string,
): Promise<void> {
  const assetPath = resolveAssetPath(assetDir, requestPath);
  if (!assetPath) {
    writePlain(res, 404, "Not Found");
    return;
  }

  try {
    const info = await stat(assetPath);
    if (!info.isFile()) {
      writePlain(res, 404, "Not Found");
      return;
    }
  } catch {
    writePlain(res, 404, "Not Found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentTypeFor(assetPath) });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(assetPath);
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.pipe(res);
  });
}

function resolveAssetPath(assetDir: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0] ?? requestPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded.replace(/^\/+/, ""));
  if (relative === ".." || relative.startsWith(`..${sep}`) || relative.startsWith("/")) {
    return null;
  }
  return join(assetDir, relative || "index.html");
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
