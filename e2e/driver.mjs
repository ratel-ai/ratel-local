// End-to-end driver: spawns the REAL `ratel-local serve` over stdio (exactly how
// Claude Code connects) and drives the gateway through real MCP calls.
// Asserts the full pull-path surface: tool list, the two reserved buckets
// (no-starvation), invoke round-trip to the real upstream, and skill dispatch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HOME = process.env.E2E_HOME;
const BIN = process.env.E2E_BIN;
const CONFIG = process.env.E2E_CONFIG;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name}${detail ? `\n      got: ${detail}` : ""}`);
    failures++;
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: [BIN, "serve", CONFIG],
  env: { ...process.env, HOME, RATEL_TELEMETRY: "off" },
  stderr: "inherit", // surface the gateway's own [ratel] boot logs
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

// A1 — the gateway surface includes the designed set plus the deprecated
// search_tools compatibility shim.
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "A1  surface includes capability tools, auth, and the deprecated search_tools shim",
  JSON.stringify(names) ===
    JSON.stringify(["auth", "get_skill_content", "invoke_tool", "search_capabilities", "search_tools"]),
  JSON.stringify(names),
);

// A2 — search returns BOTH buckets; the supabase SKILL survives 4 matching TOOLS.
const searchRes = await client.callTool({ name: "search_capabilities", arguments: { query: "supabase" } });
const parsed = JSON.parse(searchRes.content[0].text);
const toolHits = (parsed.tools?.groups ?? []).flatMap((g) => g.hits.map((h) => h.toolId));
const skillHits = (parsed.skills ?? []).map((s) => s.skillId);
const supabaseToolCount = toolHits.filter((id) => id.includes("supabase")).length;
check("A2a tools bucket returns supabase upstream tools", supabaseToolCount >= 2, JSON.stringify(toolHits));
check(
  `A2b skills bucket returns 'supabase-auth' (NOT starved by ${supabaseToolCount} matching tools)`,
  skillHits.includes("supabase-auth"),
  `skills=${JSON.stringify(skillHits)}`,
);

// A3 — invoke_tool actually round-trips to the real upstream MCP process.
const invokeRes = await client.callTool({
  name: "invoke_tool",
  arguments: { toolId: "up__supabase_query", args: { sql: "select 1" } },
});
const invokeText = invokeRes.content[0].text;
check(
  "A3  invoke_tool round-trips to the real upstream (returns its output)",
  invokeText.includes("supabase_query executed") && invokeText.includes("select 1"),
  invokeText.slice(0, 140),
);

// A4 — get_skill_content returns the actual skill body on demand.
const skillRes = await client.callTool({ name: "get_skill_content", arguments: { skillId: "supabase-auth" } });
const skillBody = JSON.parse(skillRes.content[0].text);
check(
  "A4  get_skill_content returns the skill body",
  typeof skillBody.body === "string" && skillBody.body.includes("BODY-MARKER-SUPABASE-AUTH"),
  JSON.stringify(skillBody).slice(0, 140),
);

// A5 — an unknown skill id is a clean, declared error (not a crash).
const badRes = await client.callTool({ name: "get_skill_content", arguments: { skillId: "nope" } });
const bad = JSON.parse(badRes.content[0].text);
check("A5  unknown skillId returns a declared error (no crash)", typeof bad.error === "string", JSON.stringify(bad).slice(0, 140));

await client.close();
console.log(failures === 0 ? "\nALL GATEWAY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
