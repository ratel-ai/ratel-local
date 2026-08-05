import type { BackupFs, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runTraces } from "./traces.js";
import type { HandlerCtx } from "./types.js";

const endpoint = "http://127.0.0.1:5731/otlp/v1/traces";

class MemFs implements BackupFs, JsonFs {
  async read() {
    return null;
  }
  async write() {}
  async writeAtomic() {}
  async remove() {}
  async mkdirp() {}
  async exists() {
    return false;
  }
  async list() {
    return [];
  }
}

function context(
  verb: "status" | "enable" | "disable",
  flags: Record<string, string | boolean | string[]> = {},
  prompts: PromptAdapter = silentPromptAdapter(),
) {
  const output: string[] = [];
  const ctx: HandlerCtx = {
    argv: { group: "traces", verb, configPaths: [], rest: [], extras: [], flags },
    env: { homeDir: "/home/u" },
    fs: new MemFs(),
    log: (message) => output.push(message),
    prompts,
  };
  return { ctx, output };
}

function status(
  state: "disabled" | "configured" | "conflict" = "disabled",
  cloudConfigured = false,
) {
  return {
    endpoint,
    cloudConfigured,
    hosts: [
      {
        hostKind: "claude-code",
        displayName: "Claude Code",
        configPath: "/home/u/.claude/settings.json",
        state,
        restartRequired: state === "configured",
        conflictingFields: state === "conflict" ? ["OTEL_TRACES_EXPORTER"] : [],
        warnings: [],
      },
      {
        hostKind: "codex",
        displayName: "Codex",
        configPath: "/home/u/.codex/config.toml",
        state: "disabled",
        restartRequired: false,
        conflictingFields: [],
        warnings: [],
      },
    ],
  };
}

function response(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("runTraces", () => {
  it("shows both hosts by default and filters JSON status", async () => {
    const all = context("status");
    await runTraces(all.ctx, { request: async () => response(status()) });
    expect(all.output.join("\n")).toContain("Claude Code");
    expect(all.output.join("\n")).toContain("Codex");

    const filtered = context("status", { agent: "codex", json: true });
    await runTraces(filtered.ctx, { request: async () => response(status()) });
    const body = JSON.parse(filtered.output.join("\n"));
    expect(body.hosts.map((host: { hostKind: string }) => host.hostKind)).toEqual(["codex"]);
  });

  it("requires an explicit agent for mutations", async () => {
    const { ctx } = context("enable", { yes: true });
    await expect(runTraces(ctx, { request: async () => response(status()) })).rejects.toThrow(
      /at least one --agent/,
    );
  });

  it("prepares and commits a secret-free enable", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const { ctx, output } = context("enable", { agent: ["claude-code", "codex"], yes: true });
    await runTraces(ctx, {
      request: async (path, init) => {
        calls.push({ path, body: init?.body });
        if (path === "/api/agent-traces") return response(status());
        if (path === "/api/agent-traces/prepare") {
          return response({ changeId: "trace-1", kind: "agent-traces.enable", preview: {} });
        }
        return response({
          result: {
            action: "enable",
            hosts: status("configured").hosts.map((host) => ({ ...host, state: "configured" })),
          },
        });
      },
    });
    expect(calls).toEqual([
      { path: "/api/agent-traces", body: undefined },
      {
        path: "/api/agent-traces/prepare",
        body: { action: "enable", hostKinds: ["claude-code", "codex"], overwrite: false },
      },
      { path: "/api/changes/trace-1/commit", body: undefined },
    ]);
    expect(output.join("\n")).toContain("Ratel Cloud tracing is not configured");
    expect(output.join("\n")).toContain("https://cloud.ratel.sh/settings");
  });

  it("offers masked Ratel Cloud API key setup after an interactive enable", async () => {
    const secret = "rtl_secret_canary";
    const notes: string[] = [];
    const confirm = vi.fn(async () => true);
    const password = vi.fn(async () => secret);
    const prompts: PromptAdapter = {
      ...silentPromptAdapter(),
      note: (message) => notes.push(message),
      confirm,
      password,
    };
    const { ctx, output } = context("enable", { agent: "claude-code" }, prompts);
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];

    await runTraces(ctx, {
      request: async (path, init) => {
        calls.push({ path, method: init?.method, body: init?.body });
        if (path === "/api/agent-traces") return response(status());
        if (path === "/api/agent-traces/prepare") return response({ changeId: "trace-1" });
        if (path === "/api/changes/trace-1/commit") {
          return response({
            result: { action: "enable", hosts: [status("configured").hosts[0]] },
          });
        }
        if (path === "/api/cloud-traces" && init?.method === "PATCH") {
          return response({ configured: true, endpoint: "https://cloud.ratel.sh/api/v1/traces" });
        }
        if (path === "/api/cloud-traces") {
          return response({ configured: false, endpoint: "https://cloud.ratel.sh/api/v1/traces" });
        }
        throw new Error(`unexpected request: ${path}`);
      },
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(password).toHaveBeenCalledOnce();
    expect(notes.join("\n")).toContain("https://cloud.ratel.sh/settings");
    expect(calls).toContainEqual({
      path: "/api/cloud-traces",
      method: "PATCH",
      body: { endpoint: "https://cloud.ratel.sh/api/v1/traces", apiKey: secret },
    });
    expect(output.join("\n")).toContain("Ratel Cloud tracing configured");
    expect(output.join("\n")).not.toContain(secret);
  });

  it("leaves Cloud tracing unconfigured when interactive setup is declined", async () => {
    let confirmation = 0;
    const notes: string[] = [];
    const prompts: PromptAdapter = {
      ...silentPromptAdapter(),
      note: (message) => notes.push(message),
      async confirm() {
        confirmation += 1;
        return confirmation === 1;
      },
    };
    const { ctx } = context("enable", { agent: "claude-code" }, prompts);
    const paths: string[] = [];
    await runTraces(ctx, {
      request: async (path) => {
        paths.push(path);
        if (path === "/api/agent-traces") return response(status());
        if (path === "/api/agent-traces/prepare") return response({ changeId: "trace-1" });
        return response({
          result: { action: "enable", hosts: [status("configured").hosts[0]] },
        });
      },
    });
    expect(paths).not.toContain("/api/cloud-traces");
    expect(notes.join("\n")).toContain("https://cloud.ratel.sh/settings");
  });

  it("requires overwrite plus yes for non-interactive conflicts", async () => {
    const { ctx } = context("enable", { agent: "claude-code", yes: true });
    await expect(
      runTraces(ctx, { request: async () => response(status("conflict")) }),
    ).rejects.toThrow(/both --overwrite and --yes/);
  });

  it("warns and confirms an irreversible interactive overwrite", async () => {
    const notes: string[] = [];
    const confirm = vi.fn(async () => true);
    const prompts = {
      ...silentPromptAdapter(),
      note: (message: string) => notes.push(message),
      confirm,
    };
    const { ctx } = context("enable", { agent: "claude-code" }, prompts);
    const requests: unknown[] = [];
    await runTraces(ctx, {
      request: async (path, init) => {
        requests.push(init?.body);
        if (path === "/api/agent-traces") return response(status("conflict", true));
        if (path === "/api/agent-traces/prepare") return response({ changeId: "change" });
        return response({ result: { action: "enable", hosts: [status("configured").hosts[0]] } });
      },
    });
    expect(notes.join("\n")).toContain("No backup is retained");
    expect(confirm).toHaveBeenCalledOnce();
    expect(requests).toContainEqual({
      action: "enable",
      hostKinds: ["claude-code"],
      overwrite: true,
    });
  });

  it("never prints exporter credentials returned in an error payload", async () => {
    const secret = "secret-canary";
    const { ctx, output } = context("enable", { agent: "claude-code", yes: true });
    await expect(
      runTraces(ctx, {
        request: async (path) =>
          path === "/api/agent-traces"
            ? response(status())
            : response({ error: "trace exporter conflict" }, { status: 409 }),
      }),
    ).rejects.toThrow("trace exporter conflict");
    expect(output.join("\n")).not.toContain(secret);
  });
});
