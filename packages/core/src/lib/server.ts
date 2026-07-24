import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  EmbedderError,
  type ExecutableTool,
  formatUpstreamLine,
  getSkillContentTool,
  invokeToolTool,
  type JSONSchema7,
  SEARCH_CAPABILITIES_ID,
  SEARCH_TOOLS_ID,
  type SkillCatalog,
  searchCapabilitiesTool,
  searchToolsTool,
  type ToolCatalog,
  type UpstreamServerInfo,
} from "@ratel-ai/sdk";
import { isPlainObject } from "../json.js";
import { type AuthRunner, authTool } from "./tools/auth.js";

export interface CreateMcpServerOptions {
  name: string;
  version: string;
  transport: Transport;
  /** Mutated in place when invoke_tool sees a 401 — the matching entry's `needsAuth` flips to true. */
  upstreamServers?: UpstreamServerInfo[];
  /** When provided, registers the `auth` tool and declares `tools.listChanged` so hosts refresh on auth state changes. */
  runAuthFlow?: AuthRunner;
  /** When non-empty, the search returns a `skills` bucket and `get_skill_content` is registered. */
  skillCatalog?: SkillCatalog;
}

export interface McpServerHandle {
  close: () => Promise<void>;
  /** Emits `notifications/tools/list_changed` so hosts re-fetch the tool list (e.g., after a successful auth flow). */
  notifyToolListChanged: () => Promise<void>;
}

export async function createMcpServer(
  catalog: ToolCatalog,
  options: CreateMcpServerOptions,
): Promise<McpServerHandle> {
  const { name, version, transport, upstreamServers, runAuthFlow, skillCatalog } = options;
  const hasSkills = skillCatalog !== undefined && skillCatalog.size() > 0;

  const server = new Server(
    { name, version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: buildServerInstructions(upstreamServers, hasSkills),
    },
  );

  const onUnauthorized = (upstream: string): void => {
    const info = upstreamServers?.find((u) => u.name === upstream);
    if (info && !info.needsAuth) {
      info.needsAuth = true;
    }
    catalog.recordEvent({ type: "auth_needs", upstream });
    void server.sendToolListChanged().catch(() => undefined);
  };

  const gateway: Record<string, ExecutableTool> = {};
  const skills = hasSkills ? skillCatalog : undefined;
  const searchCapabilities = withRetrievalErrorSchema(
    searchCapabilitiesTool(catalog, skills, { upstreamServers }),
  );
  for (const tool of [searchCapabilities, invokeToolTool(catalog, { onUnauthorized })]) {
    gateway[tool.name] = tool;
  }
  // Backward-compat: keep advertising the pre-0.2.0 `search_tools` (deprecated
  // alias, tools-only `{ groups }` result) so MCP clients that pinned its name
  // don't break on upgrade. New clients should use `search_capabilities` — which
  // also returns skills — so the description steers them there.
  const legacySearch = withRetrievalErrorSchema(searchToolsTool(catalog, { upstreamServers }));
  gateway[legacySearch.name] = {
    ...legacySearch,
    description: `[Deprecated: prefer search_capabilities, which also returns skills.] ${legacySearch.description}`,
  };
  if (skills) {
    const t = getSkillContentTool(skills);
    gateway[t.name] = t;
  }
  if (runAuthFlow) {
    const t = authTool(upstreamServers ?? [], runAuthFlow);
    gateway[t.name] = t;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(gateway).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { [k: string]: unknown; type: "object" },
      ...(isObjectSchema(tool.outputSchema)
        ? { outputSchema: tool.outputSchema as { [k: string]: unknown; type: "object" } }
        : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = gateway[req.params.name];
    if (!tool) {
      throw new Error(`unknown gateway tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let out: unknown;
    try {
      out = await tool.execute(args);
    } catch (error) {
      if (
        !(error instanceof EmbedderError) ||
        (req.params.name !== SEARCH_CAPABILITIES_ID && req.params.name !== SEARCH_TOOLS_ID)
      ) {
        throw error;
      }
      out = {
        error: "retrieval_failed",
        code: error.code,
        message: error.message,
        isError: true,
      };
    }
    return wrapResult(out);
  });

  await server.connect(transport);

  return {
    close: async () => {
      await server.close();
    },
    notifyToolListChanged: async () => {
      await server.sendToolListChanged();
    },
  };
}

const RETRIEVAL_ERROR_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    error: { const: "retrieval_failed" },
    code: { type: "string" },
    message: { type: "string" },
    isError: { const: true },
  },
  required: ["error", "code", "message", "isError"],
  additionalProperties: false,
};

function withRetrievalErrorSchema(tool: ExecutableTool): ExecutableTool {
  if (!isObjectSchema(tool.outputSchema)) return tool;
  return {
    ...tool,
    outputSchema: {
      type: "object",
      oneOf: [tool.outputSchema, RETRIEVAL_ERROR_SCHEMA],
    },
  };
}

function buildServerInstructions(
  upstreams?: readonly UpstreamServerInfo[],
  hasSkills = false,
): string {
  const base =
    "This is the Ratel context-engineering gateway. Before responding to a substantive user request, " +
    "call `search_capabilities` first — even when you could answer from general knowledge or think you " +
    "lack access. Ratel may have a purpose-built tool or skill. Always search before saying information " +
    "or a workflow is unavailable. Skip the search only for casual conversation, simple acknowledgments, " +
    "clarifying questions, or requests that are plainly pure writing or reasoning with no plausible " +
    "task-specific capability. When in doubt, search. Run a returned tool via `invoke_tool`.";
  const skills = hasSkills
    ? " The search also returns a `skills` bucket (reusable playbooks); load one in full via " +
      "`get_skill_content` and follow it."
    : "";
  const intro = `${base}${skills}`;
  if (!upstreams || upstreams.length === 0) return intro;
  const list = upstreams.map(formatUpstreamLine).join("\n");
  return `${intro}\n\nThis catalog aggregates tools from these upstream MCP servers:\n${list}`;
}

function isObjectSchema(schema: unknown): boolean {
  // MCP requires outputSchema (when set) to be a JSON Schema with `type: "object"`.
  // Only object-typed schemas are forwarded; anything else is omitted at this boundary.
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { type?: unknown }).type === "object"
  );
}

function wrapResult(out: unknown) {
  const text = JSON.stringify(out);
  const isStructuredObject = isPlainObject(out);
  // Gateway tools signal a failed call by returning `{ isError: true, ... }`
  // (e.g. unknown toolId/skillId). Promote it to MCP's `isError` so the host and
  // model can tell a failure from real content, not just read it as data.
  const isError = isStructuredObject && out.isError === true;
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
    ...(isStructuredObject ? { structuredContent: out } : {}),
  };
}
