import { appendFile, chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

// Lock tuning for the state.json filesystem mutex (mkdir is atomic on POSIX).
const LOCK_RETRY_MS = 20; // base backoff between acquire attempts
const LOCK_JITTER_MS = 15; // random jitter added to each backoff (avoids thundering herd)
const LOCK_MAX_TRIES = 250; // generous acquisition budget (~5s worst case) before fallback
const LOCK_STALE_MS = 10000; // steal locks older than this (crashed holder)

// Secret redaction. Each entry redacts the value while preserving a labelled
// prefix where one exists, so captured chat stays readable but never leaks
// credentials. Order matters: structured/labelled patterns run before the
// broad token patterns. Applied to every captured turn (user + assistant).
const REDACTIONS = [
  // PEM private key blocks (any key type) — collapse the whole block.
  {
    re: /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*)PRIVATE KEY-----/g,
    to: "[REDACTED_PRIVATE_KEY]",
  },
  // JWTs (three base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, to: "[REDACTED_JWT]" },
  // OpenAI-style keys.
  { re: /\b(sk-[A-Za-z0-9_-]{16,})\b/g, to: "[REDACTED]" },
  // Bearer tokens.
  { re: /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi, to: "$1 [REDACTED]" },
  // Slack tokens.
  { re: /\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, to: "[REDACTED]" },
  // GitHub tokens.
  { re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, to: "[REDACTED]" },
  // AWS access key ids.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: "[REDACTED_AWS_KEY]" },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, to: "[REDACTED_GOOGLE_KEY]" },
  // aws_secret_access_key assignments (=, :, or =>), quoted or bare.
  {
    re: /\b(aws_secret_access_key)(\s*[:=]>?\s*)(['"]?)[^\s'"]+\3/gi,
    to: "$1$2$3[REDACTED]$3",
  },
  // Generic credential assignments (password/passwd/secret/token/api_key).
  {
    re: /\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]>?\s*)(['"]?)[^\s'"]+\3/gi,
    to: "$1$2$3[REDACTED]$3",
  },
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
  // Only bump the new-turn counter if the turn was actually persisted, so a
  // failed write can't desync the count from the JSONL the core later reads.
  const wrote = await appendTurn(chatDir, host, sessionId, { role: "user", content: clean(prompt) });
  if (!wrote) return;
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
    const wrote = await appendTurn(chatDir, host, sessionId, { role: "assistant", content: clean(text) });
    if (wrote) appended++;
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

// Append a single turn to the session's JSONL log. Append-only writes to a
// per-session file are inherently safe under concurrency (no read-modify-write),
// so no lock is needed here. Fully fail-soft: a write failure must never throw
// out of the hook. Returns true on success so callers can keep counts honest.
async function appendTurn(chatDir, host, sessionId, turn) {
  try {
    const dir = join(chatDir, host);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    const file = join(dir, `${sessionId}.jsonl`);
    const record = { ...turn, ts: new Date().toISOString() };
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: FILE_MODE });
    await chmod(file, FILE_MODE).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// Recover gracefully from a missing/corrupt state.json: treat anything we can't
// parse into the expected shape as an empty state rather than crashing.
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

// Serialize the whole read-modify-write of state.json across concurrent hook
// subprocesses so parallel UserPromptSubmit/Stop events can't clobber each
// other's counters. `update` runs INSIDE the lock against a fresh read, so
// increments are always applied on top of other writers' results.
async function updateState(chatDir, sessionId, update) {
  await mkdir(chatDir, { recursive: true, mode: DIR_MODE }).catch(() => undefined);
  const path = join(chatDir, "state.json");
  const lockDir = `${path}.lock`;

  const locked = await acquireLock(lockDir);
  try {
    const state = await readState(chatDir);
    const next = {
      version: 1,
      sessions: { ...state.sessions, [sessionId]: update(state.sessions[sessionId] ?? {}) },
    };
    await atomicWriteState(path, next);
  } finally {
    // Only release a lock we actually own; if we fell back without one, leave
    // any foreign lock alone for its owner / the stale-steal path.
    if (locked) await rmdir(lockDir).catch(() => undefined);
  }
}

// Atomic temp-file + rename write of state.json. Cleans up the temp file on any
// failure so a crash can never leave `.ratel-tmp-*` litter behind.
async function atomicWriteState(path, next) {
  const tmp = `${path}.ratel-tmp-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
    await rename(tmp, path);
    await chmod(path, FILE_MODE).catch(() => undefined);
  } catch {
    await unlink(tmp).catch(() => undefined);
  }
}

// Acquire a filesystem mutex by creating a lock directory (mkdir is atomic on
// POSIX). Retries with a short backoff, steals stale locks left by crashed
// holders, and ultimately falls back to a best-effort write so the hook never
// blocks or breaks the host agent.
// Returns true if we own the lock, false if we proceeded without it.
async function acquireLock(lockDir) {
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      await mkdir(lockDir, { mode: DIR_MODE });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        // Unexpected error (e.g. permissions) — give up on locking, write anyway.
        return false;
      }
      if (await isLockStale(lockDir)) {
        // Holder appears dead (lock dir is genuinely old): steal it, then retry.
        await rmdir(lockDir).catch(() => undefined);
        continue;
      }
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_JITTER_MS));
    }
  }
  // Budget exhausted: proceed best-effort without the lock rather than block.
  return false;
}

// A lock is "stale" only when its directory genuinely exists AND is older than
// the threshold (its holder almost certainly crashed). If stat throws (e.g. the
// lock vanished because its holder just released it), we must NOT treat it as
// stale: doing so could rmdir a brand-new lock another writer just acquired,
// letting two writers enter the critical section. Return false → plain retry.
async function isLockStale(lockDir) {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(text) {
  let out = text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}[TRUNCATED]` : text;
  for (const { re, to } of REDACTIONS) out = out.replace(re, to);
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
