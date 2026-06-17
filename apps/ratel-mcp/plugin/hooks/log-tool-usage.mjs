import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const REDACTED = "[REDACTED]";
const REDACT_KEY_RE =
  /(?:authorization|bearer|cookie|credential|password|secret|token|api[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token)/i;

await main().catch(() => {
  // Hooks must never interfere with the tool call they are observing.
});

async function main() {
  const eventName = process.argv[2] || "unknown";
  const input = await readStdin();
  const payload = parsePayload(input);
  const logPath = join(resolveRatelDir(), "tool-usage", "tool-usage.jsonl");
  const record = buildRecord(eventName, payload);

  await mkdir(join(resolveRatelDir(), "tool-usage"), { recursive: true, mode: DIR_MODE });
  await chmod(resolveRatelDir(), DIR_MODE).catch(() => undefined);
  await chmod(join(resolveRatelDir(), "tool-usage"), DIR_MODE).catch(() => undefined);
  await appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await chmod(logPath, FILE_MODE).catch(() => undefined);
}

function buildRecord(eventName, payload) {
  const toolInput = firstPresent(payload, [
    ["tool_input"],
    ["toolInput"],
    ["input"],
    ["arguments"],
    ["args"],
    ["tool_call", "input"],
    ["toolCall", "input"],
  ]);
  const toolResponse = firstPresent(payload, [
    ["tool_response"],
    ["toolResponse"],
    ["response"],
    ["result"],
    ["tool_call", "response"],
    ["toolCall", "response"],
  ]);

  return compact({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    host: detectHost(),
    event: eventName,
    sessionId: stringValue(firstPresent(payload, [["session_id"], ["sessionId"]])),
    cwd: stringValue(firstPresent(payload, [["cwd"], ["working_directory"], ["workingDirectory"]])),
    transcriptPath: stringValue(firstPresent(payload, [["transcript_path"], ["transcriptPath"]])),
    toolName: stringValue(
      firstPresent(payload, [
        ["tool_name"],
        ["toolName"],
        ["name"],
        ["tool", "name"],
        ["tool_call", "name"],
        ["toolCall", "name"],
      ]),
    ),
    toolCallId: stringValue(
      firstPresent(payload, [
        ["tool_use_id"],
        ["toolUseId"],
        ["tool_call_id"],
        ["toolCallId"],
        ["id"],
        ["tool_call", "id"],
        ["toolCall", "id"],
      ]),
    ),
    toolInput: toolInput === undefined ? undefined : sanitize(toolInput, { maxString: 4000 }),
    outcome: summarizeOutcome(payload, toolResponse),
    payloadKeys: objectKeys(payload),
  });
}

function summarizeOutcome(payload, toolResponse) {
  if (toolResponse === undefined) return undefined;
  const error = firstPresent(payload, [
    ["error"],
    ["tool_error"],
    ["toolError"],
    ["tool_response", "error"],
    ["toolResponse", "error"],
  ]);
  const isError = firstPresent(payload, [
    ["is_error"],
    ["isError"],
    ["tool_response", "is_error"],
    ["toolResponse", "isError"],
  ]);
  const status = firstPresent(payload, [
    ["status"],
    ["decision"],
    ["tool_response", "status"],
    ["toolResponse", "status"],
  ]);

  return compact({
    status: stringValue(status),
    isError: typeof isError === "boolean" ? isError : error !== undefined ? true : undefined,
    error: error === undefined ? undefined : sanitize(error, { maxDepth: 3, maxItems: 20, maxString: 1200 }),
    response: sanitize(toolResponse, { maxDepth: 4, maxItems: 30, maxString: 1200 }),
  });
}

function parsePayload(input) {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return { raw: truncate(input, 2000), parseError: true };
  }
}

function sanitize(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 6;
  const maxItems = options.maxItems ?? 50;
  const maxString = options.maxString ?? 2000;

  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value, maxString);
  if (typeof value !== "object") return stringValue(value);
  if (depth >= maxDepth) return "[TRUNCATED_DEPTH]";

  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => sanitize(item, options, depth + 1));
    if (value.length > maxItems) items.push(`[TRUNCATED_ITEMS:${value.length - maxItems}]`);
    return items;
  }

  const entries = Object.entries(value);
  const out = {};
  for (const [key, item] of entries.slice(0, maxItems)) {
    out[key] = REDACT_KEY_RE.test(key) ? REDACTED : sanitize(item, options, depth + 1);
  }
  if (entries.length > maxItems) out.__truncatedKeys = entries.length - maxItems;
  return out;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}[TRUNCATED:${value.length - maxLength}]`;
}

function firstPresent(value, paths) {
  for (const path of paths) {
    const found = valueAt(value, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

function valueAt(value, path) {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object" || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function objectKeys(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.keys(value).sort();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stringValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function detectHost() {
  if (process.env.PLUGIN_ROOT) return "codex";
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return "unknown";
}

function resolveRatelDir() {
  return process.env.RATEL_HOME || join(homedir(), ".ratel");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
