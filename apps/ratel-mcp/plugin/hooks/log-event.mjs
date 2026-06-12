import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const eventName = process.argv[2] || "unknown";
const input = await readStdin();
const dataDir = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "ratel-mcp-plugin");
const logPath = join(dataDir, "hooks.jsonl");

let payload;
try {
  payload = input ? JSON.parse(input) : null;
} catch {
  payload = { raw: input };
}

const record = {
  at: new Date().toISOString(),
  event: eventName,
  source: process.env.PLUGIN_ROOT ? "codex" : process.env.CLAUDE_PLUGIN_ROOT ? "claude-code" : "unknown",
  payload
};

await mkdir(dataDir, { recursive: true });
await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
