import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

export const CONNECTOR_PROTOCOL_VERSION = "1";
export const CONNECTOR_PROTOCOL_HEADER = "x-ratel-connector-protocol";
export const PROJECT_ROOT_HEADER = "x-ratel-project-root";

export type DaemonRequestScope = { kind: "user" } | { kind: "project"; projectRoot: string };

export class DaemonAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonAccessError";
  }
}

export function daemonTokenPath(homeDir: string): string {
  return join(homeDir, ".ratel", "daemon-token");
}

export async function ensureDaemonToken(homeDir: string): Promise<string> {
  const ratelDir = join(homeDir, ".ratel");
  const path = daemonTokenPath(homeDir);
  await mkdir(ratelDir, { recursive: true });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!existing) throw new Error(`daemon token at ${path} is empty`);
    await chmod(path, 0o600);
    return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = (await readFile(path, "utf8")).trim();
    if (!existing) throw new Error(`daemon token at ${path} is empty`);
    await chmod(path, 0o600);
    return existing;
  }
}

export async function readDaemonToken(homeDir: string): Promise<string | null> {
  try {
    const token = (await readFile(daemonTokenPath(homeDir), "utf8")).trim();
    return token || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function connectorHeaders(token: string, projectRoot?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    [CONNECTOR_PROTOCOL_HEADER]: CONNECTOR_PROTOCOL_VERSION,
    ...(projectRoot
      ? { [PROJECT_ROOT_HEADER]: Buffer.from(projectRoot, "utf8").toString("base64url") }
      : {}),
  };
}

export async function resolveDaemonRequestScope(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  expectedToken: string,
): Promise<DaemonRequestScope> {
  authorizeDaemonRequest(headers, expectedToken);
  const encodedRoot = firstHeader(headers[PROJECT_ROOT_HEADER]);
  const protocol = firstHeader(headers[CONNECTOR_PROTOCOL_HEADER]);
  if (protocol !== undefined && protocol !== CONNECTOR_PROTOCOL_VERSION) {
    throw new DaemonAccessError(
      `unsupported connector protocol ${protocol}; expected ${CONNECTOR_PROTOCOL_VERSION}`,
      426,
    );
  }
  if (!encodedRoot) return { kind: "user" };
  if (protocol !== CONNECTOR_PROTOCOL_VERSION) {
    throw new DaemonAccessError(
      "project-scoped connections require a compatible connector protocol",
      426,
    );
  }
  if (encodedRoot.length > 8_192) {
    throw new DaemonAccessError("project root header is too large", 400);
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encodedRoot, "base64url").toString("utf8");
  } catch {
    throw new DaemonAccessError("project root header is invalid", 400);
  }
  if (!decoded || decoded.includes("\0")) {
    throw new DaemonAccessError("project root header is invalid", 400);
  }

  try {
    const canonical = await realpath(decoded);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("not a directory");
    return { kind: "project", projectRoot: canonical };
  } catch (err) {
    throw new DaemonAccessError(`project root is unavailable: ${(err as Error).message}`, 400);
  }
}

export function authorizeDaemonRequest(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  expectedToken: string,
): void {
  const authorization = firstHeader(headers.authorization);
  if (!authorization?.startsWith("Bearer ")) {
    throw new DaemonAccessError("unauthorized daemon request", 401);
  }
  const receivedToken = authorization.slice("Bearer ".length);
  if (!sameSecret(receivedToken, expectedToken)) {
    throw new DaemonAccessError("unauthorized daemon request", 401);
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
