import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Captures chat turns so the Ratel intent runner can extract intents from them.
// Two events:
//   UserPromptSubmit → append the user's turn + bump the new-turn counter
//   Stop             → flag the session idle + backfill assistant turns from the transcript
//
// Like the tool-usage logger, this hook is strictly passive and fail-soft: it
// never prints output, never returns a decision, and swallows every error so it
// cannot interfere with the host.

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CONTENT = 16000;
const REDACTIONS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi,
  /\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
];

await main().catch(() => {
  // Hooks must never interfere with the session they observe.
});

async function main() {
  // Skip capture for Ratel's own nested `claude -p` calls (e.g. skill generation),
  // so their prompts don't get recorded as chat and re-extracted as fake intents.
  if (process.env.RATEL_SKIP_CAPTURE === "1") return;
  // Respect the master switch: when analysis is disabled, don't record chat at all.
  if (await isAnalysisDisabled()) return;
  const eventName = process.argv[2] || "unknown";
  const payload = parsePayload(await readStdin());
  const sessionId = stringValue(firstPresent(payload, [["session_id"], ["sessionId"]]));
  if (!sessionId) return;

  const host = detectHost();
  const cwd = stringValue(firstPresent(payload, [["cwd"], ["working_directory"], ["workingDirectory"]]));
  const chatDir = join(resolveRatelDir(), "chat");

  if (eventName === "UserPromptSubmit") {
    await onUserPrompt({ payload, chatDir, host, sessionId, cwd });
  } else if (eventName === "Stop") {
    await onStop({ payload, chatDir, host, sessionId, cwd });
  }
}

async function onUserPrompt({ payload, chatDir, host, sessionId, cwd }) {
  const prompt = stringValue(firstPresent(payload, [["prompt"], ["user_prompt"], ["message"]]));
  if (!prompt || prompt.trim().length === 0) return;
  await appendTurn(chatDir, host, sessionId, { role: "user", content: clean(prompt) });
  await updateState(chatDir, sessionId, (meta) => ({
    ...meta,
    sessionId,
    host,
    cwd: cwd ?? meta.cwd,
    newTurnCount: (meta.newTurnCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    idle: false,
  }));
}

async function onStop({ payload, chatDir, host, sessionId, cwd }) {
  const transcriptPath = stringValue(firstPresent(payload, [["transcript_path"], ["transcriptPath"]]));
  let appended = 0;
  let cursor = 0;
  const startCursor = (await readState(chatDir)).sessions[sessionId]?.transcriptCursor ?? 0;
  if (transcriptPath) {
    const result = await backfillAssistant(chatDir, host, sessionId, transcriptPath, startCursor);
    appended = result.appended;
    cursor = result.cursor;
  }
  await updateState(chatDir, sessionId, (meta) => ({
    ...meta,
    sessionId,
    host,
    cwd: cwd ?? meta.cwd,
    newTurnCount: (meta.newTurnCount ?? 0) + appended,
    transcriptCursor: cursor || meta.transcriptCursor || startCursor,
    updatedAt: new Date().toISOString(),
    idle: true,
  }));
}

// Read the transcript JSONL, skip lines already consumed, and append any new
// assistant turns. User turns are captured via UserPromptSubmit, so they are
// skipped here to avoid duplicates.
async function backfillAssistant(chatDir, host, sessionId, transcriptPath, startCursor) {
  let raw;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return { appended: 0, cursor: startCursor };
  }
  const lines = raw.split("\n");
  let appended = 0;
  for (let i = startCursor; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const role = obj?.message?.role ?? obj?.role ?? obj?.type;
    if (role !== "assistant") continue;
    const text = extractText(obj?.message?.content ?? obj?.content);
    if (!text || text.trim().length === 0) continue;
    await appendTurn(chatDir, host, sessionId, { role: "assistant", content: clean(text) });
    appended++;
  }
  return { appended, cursor: lines.length };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

async function appendTurn(chatDir, host, sessionId, turn) {
  const dir = join(chatDir, host);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const file = join(dir, `${sessionId}.jsonl`);
  const record = { ...turn, ts: new Date().toISOString() };
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await chmod(file, FILE_MODE).catch(() => undefined);
}

async function readState(chatDir) {
  try {
    const raw = await readFile(join(chatDir, "state.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed;
  } catch {
    // missing or malformed — start fresh
  }
  return { version: 1, sessions: {} };
}

async function updateState(chatDir, sessionId, update) {
  const state = await readState(chatDir);
  const next = {
    version: 1,
    sessions: { ...state.sessions, [sessionId]: update(state.sessions[sessionId] ?? {}) },
  };
  await mkdir(chatDir, { recursive: true, mode: DIR_MODE });
  const path = join(chatDir, "state.json");
  const tmp = `${path}.ratel-tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await rename(tmp, path);
  await chmod(path, FILE_MODE).catch(() => undefined);
}

function clean(text) {
  let out = text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}[TRUNCATED]` : text;
  for (const re of REDACTIONS) out = out.replace(re, "$1[REDACTED]");
  return out;
}

function parsePayload(input) {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function firstPresent(value, paths) {
  for (const path of paths) {
    let current = value;
    let ok = true;
    for (const part of path) {
      if (current === null || typeof current !== "object" || !(part in current)) {
        ok = false;
        break;
      }
      current = current[part];
    }
    if (ok && current !== undefined) return current;
  }
  return undefined;
}

function stringValue(value) {
  return typeof value === "string" ? value : undefined;
}

function detectHost() {
  if (process.env.PLUGIN_ROOT) return "codex";
  if (process.env.CLAUDE_PLUGIN_ROOT) return "claude-code";
  return "unknown";
}

function resolveRatelDir() {
  return process.env.RATEL_HOME || join(homedir(), ".ratel");
}

// True only when the user has explicitly turned the analysis master switch off.
async function isAnalysisDisabled() {
  try {
    const raw = await readFile(join(resolveRatelDir(), "config.json"), "utf8");
    return JSON.parse(raw)?.analysis?.enabled === false;
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
