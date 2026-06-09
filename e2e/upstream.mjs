// A real upstream MCP server for the end-to-end test. Exposes several
// supabase-ish tools (to test that a matching SKILL is not starved by matching
// TOOLS) plus a couple of unrelated ones. Speaks real MCP over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  { name: "supabase_query", description: "Run a SQL query against a Supabase Postgres database." },
  { name: "supabase_migrate", description: "Apply a Supabase database migration to the project." },
  { name: "supabase_branch", description: "Create a Supabase preview branch for the project." },
  { name: "supabase_auth_user", description: "Create or update a Supabase auth user record." },
  { name: "vercel_deploy", description: "Deploy the current project to Vercel production." },
  { name: "github_open_pr", description: "Open a GitHub pull request from the current branch." },
];

const server = new Server({ name: "up", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: { sql: { type: "string" } } },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    {
      type: "text",
      text: `${req.params.name} executed with ${JSON.stringify(req.params.arguments ?? {})}`,
    },
  ],
}));

await server.connect(new StdioServerTransport());
