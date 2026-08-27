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
    logsEndpoint: "http://127.0.0.1:5731/otlp/v1/logs",
    cloudConfigured,
    hosts: [
      {
        hostKind: "claude-code",
        displayName: "Claude Code",
        configPath: "/home/u/.claude/settings.json",
        state,
        level: state === "disabled" ? "off" : state === "configured" ? "redacted" : "unknown",
        supportedLevels: ["off", "redacted", "tool-details", "full-content"],
        signals: { traces: state, logs: state },
        restartRequired: state === "configured",
        conflictingFields: state === "conflict" ? ["OTEL_TRACES_EXPORTER"] : [],
        warnings: [],
      },
      {
        hostKind: "codex",
        displayName: "Codex",
        configPath: "/home/u/.codex/config.toml",
        state: "disabled",
        level: "off",
        supportedLevels: ["off", "redacted", "tool-activity", "prompt-content"],
        signals: { traces: "disabled", logs: "disabled" },
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

  it("refuses telemetry mutations while the daemon feature flag is off", async () => {
    const { ctx } = context("enable", { agent: "claude-code", yes: true });
    const request = vi.fn(async () => response({ ...status(), featureEnabled: false }));
    await expect(runTraces(ctx, { request })).rejects.toThrow(
      /RATEL_FEATURE_CLOUD_TELEMETRY=1.*daemon restart/,
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("points at `cloud add` when Cloud is not configured yet", async () => {
    // The inline prompt used to live here. It could only ever store the first
    // credential, so storing one is now its own command.
    const { ctx, output } = context("enable", { agent: ["claude-code"], yes: true });
    await runTraces(ctx, {
      request: async (path) => {
        if (path === "/api/agent-traces") return response({ ...status(), cloudConfigured: false });
        if (path === "/api/agent-traces/prepare") {
          return response({ changeId: "trace-1", kind: "agent-traces.enable", preview: {} });
        }
        return response({ result: { action: "enable", hosts: status().hosts } });
      },
    });
    expect(output.join("\n")).toContain("ratel-local cloud add <profile>");
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
        body: {
          action: "enable",
          level: "redacted",
          hostKinds: ["claude-code", "codex"],
          overwrite: false,
        },
      },
      { path: "/api/changes/trace-1/commit", body: undefined },
    ]);
    expect(output.join("\n")).toContain("Ratel Cloud is not configured");
    expect(output.join("\n")).toContain("https://cloud.ratel.sh/settings");
  });

  it("requires an explicit content confirmation flag for non-interactive Claude levels", async () => {
    const missingConfirmation = context("enable", {
      agent: "claude-code",
      level: "full-content",
      yes: true,
    });
    await expect(
      runTraces(missingConfirmation.ctx, { request: async () => response(status()) }),
    ).rejects.toThrow(/--confirm-content/);

    const calls: Array<{ path: string; body?: unknown }> = [];
    const confirmed = context("enable", {
      agent: "claude-code",
      level: "tool-details",
      yes: true,
      "confirm-content": true,
    });
    await runTraces(confirmed.ctx, {
      request: async (path, init) => {
        calls.push({ path, body: init?.body });
        if (path === "/api/agent-traces") return response(status("disabled", true));
        if (path === "/api/agent-traces/prepare") return response({ changeId: "trace-level" });
        return response({
          result: {
            action: "enable",
            level: "tool-details",
            hosts: [
              {
                ...status("configured", true).hosts[0],
                level: "tool-details",
              },
            ],
          },
        });
      },
    });
    expect(calls).toContainEqual({
      path: "/api/agent-traces/prepare",
      body: {
        action: "enable",
        level: "tool-details",
        hostKinds: ["claude-code"],
        overwrite: false,
      },
    });
  });

  it("warns and confirms before an interactive content-bearing level", async () => {
    const notes: string[] = [];
    const confirm = vi.fn(async () => true);
    const { ctx } = context(
      "enable",
      { agent: "claude-code", level: "full-content" },
      { ...silentPromptAdapter(), note: (message) => notes.push(message), confirm },
    );
    await runTraces(ctx, {
      request: async (path) => {
        if (path === "/api/agent-traces") return response(status("disabled", true));
        if (path === "/api/agent-traces/prepare") return response({ changeId: "full" });
        return response({
          result: {
            action: "enable",
            level: "full-content",
            hosts: [{ ...status("configured", true).hosts[0], level: "full-content" }],
          },
        });
      },
    });
    expect(notes.join("\n")).toMatch(/prompts.*assistant responses.*tool content/i);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("rejects Claude-only levels for Codex before preparing a change", async () => {
    const { ctx } = context("enable", {
      agent: "codex",
      level: "tool-details",
      yes: true,
      "confirm-content": true,
    });
    await expect(runTraces(ctx, { request: async () => response(status()) })).rejects.toThrow(
      /Codex.*does not support.*tool-details/,
    );
  });

  it("requires explicit content confirmation for Codex logs", async () => {
    const missing = context("enable", {
      agent: "codex",
      level: "tool-activity",
      yes: true,
    });
    await expect(
      runTraces(missing.ctx, { request: async () => response(status()) }),
    ).rejects.toThrow(/--confirm-content/);
  });

  it("requires overwrite approval when a Codex log level would replace another exporter", async () => {
    const body = status("disabled", true);
    body.hosts[1] = {
      ...body.hosts[1],
      state: "configured",
      level: "redacted",
      signals: { traces: "configured", logs: "conflict" },
      conflictingFields: ["otel.exporter"],
    };
    const { ctx } = context("enable", {
      agent: "codex",
      level: "tool-activity",
      yes: true,
      "confirm-content": true,
    });
    await expect(runTraces(ctx, { request: async () => response(body) })).rejects.toThrow(
      /--overwrite.*--yes/,
    );
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
      level: "redacted",
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
