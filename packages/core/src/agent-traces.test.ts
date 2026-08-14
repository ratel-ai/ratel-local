import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentTraceConflictError,
  inspectAgentTraceHost,
  loopbackTraceEndpoint,
  prepareAgentTraceChange,
  rewriteClaudeTraceConfig,
  rewriteCodexTraceConfig,
} from "./agent-traces.js";
import { nodeFs } from "./io.js";
import { createMutationEngine } from "./mutation-engine.js";
import { createPreparedChangeCoordinator } from "./prepared-change-coordinator.js";

const ENDPOINT = loopbackTraceEndpoint("http://127.0.0.1:7331/otlp/v1/traces");

describe("loopback trace endpoint", () => {
  it.each([
    "https://127.0.0.1:7331/otlp/v1/traces",
    "http://localhost:7331/otlp/v1/traces",
    "http://127.0.0.1:0/otlp/v1/traces",
    "http://127.0.0.1:7331/other",
    "http://user:secret@127.0.0.1:7331/otlp/v1/traces",
  ])("rejects non-daemon endpoint %s", (value) => {
    expect(() => loopbackTraceEndpoint(value)).toThrow(/127\.0\.0\.1/);
  });
});

describe("Claude Code native trace configuration", () => {
  it("enables only the trace exporter and preserves unrelated settings", () => {
    const before = `${JSON.stringify(
      {
        theme: "dark",
        env: {
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer generic-secret-canary",
          OTEL_LOG_USER_PROMPTS: "0",
          KEEP_ME: "yes",
        },
      },
      null,
      2,
    )}\n`;

    const after = rewriteClaudeTraceConfig(before, ENDPOINT, "enable");
    const settings = JSON.parse(after) as { env: Record<string, string>; theme: string };

    expect(settings.theme).toBe("dark");
    expect(settings.env).toMatchObject({
      KEEP_ME: "yes",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer generic-secret-canary",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ENDPOINT,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:7331/otlp/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
    });
    expect(inspectAgentTraceHost("claude-code", after, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "redacted",
      supportedLevels: ["off", "redacted", "tool-details", "full-content"],
    });
    expect(JSON.stringify(inspectAgentTraceHost("claude-code", after, ENDPOINT))).not.toContain(
      "generic-secret-canary",
    );
  });

  it("writes and inspects Claude-only content detail levels without raw API bodies", () => {
    const toolDetails = rewriteClaudeTraceConfig(null, ENDPOINT, "enable", "tool-details");
    const toolSettings = JSON.parse(toolDetails) as { env: Record<string, string> };
    expect(toolSettings.env).toMatchObject({
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "0",
    });
    expect(toolSettings.env.OTEL_LOG_RAW_API_BODIES).toBe("0");
    expect(inspectAgentTraceHost("claude-code", toolDetails, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "tool-details",
    });

    const full = rewriteClaudeTraceConfig(toolDetails, ENDPOINT, "enable", "full-content");
    const fullSettings = JSON.parse(full) as { env: Record<string, string> };
    expect(fullSettings.env).toMatchObject({
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_ASSISTANT_RESPONSES: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "1",
    });
    expect(fullSettings.env.OTEL_LOG_RAW_API_BODIES).toBe("0");
    expect(inspectAgentTraceHost("claude-code", full, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "full-content",
    });
  });

  it("downgrades every content gate, including pre-existing raw API body capture", () => {
    const before = JSON.stringify({
      env: {
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOG_RAW_API_BODIES: "1",
      },
    });
    const full = rewriteClaudeTraceConfig(before, ENDPOINT, "enable", "full-content");
    const redacted = JSON.parse(rewriteClaudeTraceConfig(full, ENDPOINT, "enable", "redacted")) as {
      env: Record<string, string>;
    };
    expect(redacted.env).toMatchObject({
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOG_RAW_API_BODIES: "0",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
    });
  });

  it("recognizes stale Ratel endpoints and disables without touching other signals", () => {
    const stale = rewriteClaudeTraceConfig(
      null,
      loopbackTraceEndpoint("http://127.0.0.1:7444/otlp/v1/traces"),
      "enable",
    );
    const withLogs = JSON.stringify({
      ...JSON.parse(stale),
      env: { ...JSON.parse(stale).env, OTEL_LOGS_EXPORTER: "otlp" },
    });
    expect(inspectAgentTraceHost("claude-code", withLogs, ENDPOINT).state).toBe("stale");

    const disabled = JSON.parse(rewriteClaudeTraceConfig(withLogs, ENDPOINT, "disable")) as {
      env: Record<string, string>;
    };
    expect(disabled.env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(disabled.env.OTEL_LOGS_EXPORTER).toBe("none");
    expect(disabled.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
    expect(disabled.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined();
    expect(disabled.env.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(disabled.env.OTEL_LOG_TOOL_CONTENT).toBe("0");
  });

  it("preserves an unrelated Claude log exporter while disabling a Ratel trace route", () => {
    const traceOnly = rewriteClaudeTraceConfig(null, ENDPOINT, "enable", "redacted");
    const root = JSON.parse(traceOnly) as { env: Record<string, string> };
    root.env.OTEL_LOGS_EXPORTER = "otlp";
    root.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://logs.example/v1/logs";
    root.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = "Authorization=secret-canary";
    const disabled = JSON.parse(
      rewriteClaudeTraceConfig(JSON.stringify(root), ENDPOINT, "disable"),
    ) as { env: Record<string, string> };
    expect(disabled.env.OTEL_TRACES_EXPORTER).toBe("none");
    expect(disabled.env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(disabled.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("https://logs.example/v1/logs");
    expect(disabled.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe("Authorization=secret-canary");
  });

  it("reports only conflicting field names and privacy warnings", () => {
    const secret = "otel-secret-canary";
    const text = JSON.stringify({
      env: {
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: `Authorization=Bearer ${secret}`,
        OTEL_LOG_TOOL_CONTENT: "1",
      },
    });
    const status = inspectAgentTraceHost("claude-code", text, ENDPOINT);

    expect(status.state).toBe("conflict");
    expect(status.conflictingFields).toContain("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
    expect(status.warnings.join(" ")).toContain("OTEL_LOG_TOOL_CONTENT");
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it("never classifies raw API body file capture as a redacted level", () => {
    const configured = JSON.parse(
      rewriteClaudeTraceConfig(null, ENDPOINT, "enable", "redacted"),
    ) as { env: Record<string, string> };
    configured.env.OTEL_LOG_RAW_API_BODIES = "file:/tmp/claude-raw";

    const status = inspectAgentTraceHost("claude-code", JSON.stringify(configured), ENDPOINT);
    expect(status).toMatchObject({ state: "configured", level: "custom" });
    expect(status.warnings.join(" ")).toContain("OTEL_LOG_RAW_API_BODIES");
  });

  it("treats malformed and partially drifted settings as non-writable", () => {
    expect(inspectAgentTraceHost("claude-code", "{", ENDPOINT).state).toBe("invalid");
    const partial = rewriteClaudeTraceConfig(null, ENDPOINT, "enable").replace(
      '"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf"',
      '"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "grpc"',
    );
    expect(inspectAgentTraceHost("claude-code", partial, ENDPOINT)).toMatchObject({
      state: "conflict",
      conflictingFields: ["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"],
    });
  });
});

describe("Codex native trace configuration", () => {
  it("surgically enables traces while preserving comments and unrelated tables", () => {
    const before = `# keep this comment\nmodel = "gpt-5.6"\n\n[otel]\nlog_user_prompt = false # privacy\nmetrics_exporter = "none"\ntrace_exporter = "none"\n\n[mcp_servers.docs]\ncommand = "docs"\n`;
    const after = rewriteCodexTraceConfig(before, ENDPOINT, "enable");

    expect(after).toContain("# keep this comment");
    expect(after).toContain("log_user_prompt = false # privacy");
    expect(after).toContain("[mcp_servers.docs]");
    expect(inspectAgentTraceHost("codex", after, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "redacted",
      supportedLevels: ["off", "redacted", "tool-activity", "prompt-content"],
    });
  });

  it("adds independent content-bearing Codex log levels without promising unsupported content", () => {
    const activity = rewriteCodexTraceConfig(null, ENDPOINT, "enable", "tool-activity");
    expect(activity).toContain("exporter = { otlp-http = {");
    expect(activity).toContain("/otlp/v1/logs");
    expect(activity).toContain("log_user_prompt = false");
    expect(inspectAgentTraceHost("codex", activity, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "tool-activity",
      supportedLevels: ["off", "redacted", "tool-activity", "prompt-content"],
    });

    const prompts = rewriteCodexTraceConfig(activity, ENDPOINT, "enable", "prompt-content");
    expect(prompts).toContain("log_user_prompt = true");
    expect(inspectAgentTraceHost("codex", prompts, ENDPOINT)).toMatchObject({
      state: "configured",
      level: "prompt-content",
    });
  });

  it("preserves unrelated Codex log routing when selecting traces-only or disabling", () => {
    const before = `[otel]\nexporter = { otlp-http = { endpoint = "https://logs.example/v1/logs", protocol = "binary", headers = { Authorization = "secret-canary" } } }\nlog_user_prompt = true\n`;
    const redacted = rewriteCodexTraceConfig(before, ENDPOINT, "enable", "redacted");
    expect(redacted).toContain("https://logs.example/v1/logs");
    expect(redacted).toContain('Authorization = "secret-canary"');
    expect(redacted).toContain("log_user_prompt = true");

    const withRatelLogs = rewriteCodexTraceConfig(null, ENDPOINT, "enable", "tool-activity");
    const disabled = rewriteCodexTraceConfig(withRatelLogs, ENDPOINT, "disable");
    expect(disabled).toContain('trace_exporter = "none"');
    expect(disabled).toContain('exporter = "none"');
    expect(disabled).toContain("log_user_prompt = false");
  });

  it("replaces nested trace exporter tables without exposing existing headers", () => {
    const secret = "codex-secret-canary";
    const before = `[otel]\nenvironment = "dev"\n\n[otel.trace_exporter."otlp-http"]\nendpoint = "https://collector.example/v1/traces"\nprotocol = "binary"\nheaders = { Authorization = "Bearer ${secret}" }\n\n[profiles.fast]\nmodel = "gpt-5.6-terra"\n`;
    const status = inspectAgentTraceHost("codex", before, ENDPOINT);
    expect(status.state).toBe("conflict");
    expect(JSON.stringify(status)).not.toContain(secret);

    const after = rewriteCodexTraceConfig(before, ENDPOINT, "enable");
    expect(after).not.toContain(secret);
    expect(after).toContain("[profiles.fast]");
    expect(inspectAgentTraceHost("codex", after, ENDPOINT).state).toBe("configured");
  });

  it("recognizes stale Ratel configuration and disables with an explicit selector", () => {
    const stale = rewriteCodexTraceConfig(
      "# codex\n",
      loopbackTraceEndpoint("http://127.0.0.1:7555/otlp/v1/traces"),
      "enable",
    );
    expect(inspectAgentTraceHost("codex", stale, ENDPOINT).state).toBe("stale");
    const disabled = rewriteCodexTraceConfig(stale, ENDPOINT, "disable");
    expect(disabled).toContain('trace_exporter = "none"');
    expect(inspectAgentTraceHost("codex", disabled, ENDPOINT).state).toBe("disabled");
  });

  it("classifies malformed and partially drifted TOML without returning values", () => {
    expect(inspectAgentTraceHost("codex", "[otel", ENDPOINT).state).toBe("invalid");
    const secret = "partial-secret-canary";
    const partial = `[otel]\ntrace_exporter = { otlp-http = { endpoint = "${ENDPOINT}", protocol = "grpc", headers = { authorization = "${secret}" } } }\n`;
    const status = inspectAgentTraceHost("codex", partial, ENDPOINT);
    expect(status).toMatchObject({ state: "conflict", conflictingFields: ["otel.trace_exporter"] });
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});

describe("prepared native trace changes", () => {
  it("defaults legacy enable requests to redacted and rejects unsupported Codex levels", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-levels-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      const context = { env: { homeDir }, fs: nodeFs };
      const prepared = await prepareAgentTraceChange(context, {
        action: "enable",
        hostKinds: ["claude-code"],
        endpoint: ENDPOINT,
        preparedChanges,
      });
      expect(prepared.preview).toMatchObject({
        action: "enable",
        level: "redacted",
        hosts: [{ beforeLevel: "off", afterLevel: "redacted" }],
      });

      const codexPrepared = await prepareAgentTraceChange(context, {
        action: "enable",
        level: "tool-activity",
        hostKinds: ["codex"],
        endpoint: ENDPOINT,
        preparedChanges,
      });
      expect(codexPrepared.preview).toMatchObject({
        level: "tool-activity",
        hosts: [{ afterLevel: "tool-activity" }],
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("treats disabling an already-disabled host as an idempotent no-op", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-disabled-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      const prepared = await prepareAgentTraceChange(
        { env: { homeDir }, fs: nodeFs },
        {
          action: "disable",
          hostKinds: ["codex"],
          endpoint: ENDPOINT,
          preparedChanges,
        },
      );
      expect(prepared.preview.hosts[0]).toMatchObject({
        beforeState: "disabled",
        afterState: "disabled",
        changed: false,
      });
      await preparedChanges.commit(prepared.changeId);
      await expect(readFile(join(homeDir, ".codex", "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("requires explicit overwrite and never exposes displaced secrets", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-"));
    const secret = "prepared-secret-canary";
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      await mkdir(join(homeDir, ".codex"), { recursive: true });
      await writeFile(
        join(homeDir, ".codex", "config.toml"),
        `[otel]\ntrace_exporter = { otlp-http = { endpoint = "https://old.example/v1/traces", headers = { Authorization = "${secret}" } } }\n`,
      );
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      const context = { env: { homeDir }, fs: nodeFs };

      await expect(
        prepareAgentTraceChange(context, {
          action: "enable",
          hostKinds: ["codex"],
          endpoint: ENDPOINT,
          preparedChanges,
        }),
      ).rejects.toBeInstanceOf(AgentTraceConflictError);

      const prepared = await prepareAgentTraceChange(context, {
        action: "enable",
        hostKinds: ["codex"],
        endpoint: ENDPOINT,
        overwrite: true,
        preparedChanges,
      });
      expect(JSON.stringify(prepared)).not.toContain(secret);
      expect(prepared.preview.hosts[0]).toMatchObject({
        hostKind: "codex",
        beforeState: "conflict",
        afterState: "configured",
        overwroteConflict: true,
      });

      const committed = await preparedChanges.commit(prepared.changeId);
      expect(committed.backupManifest).toBeNull();
      expect(JSON.stringify(committed)).not.toContain(secret);
      expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).not.toContain(secret);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves an unrelated Codex log exporter at redacted and conflicts only for log levels", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-log-conflict-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      await mkdir(join(homeDir, ".codex"), { recursive: true });
      await writeFile(
        join(homeDir, ".codex", "config.toml"),
        '[otel]\nexporter = { otlp-http = { endpoint = "https://logs.example/v1/logs", protocol = "binary", headers = {} } }\n',
      );
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      const context = { env: { homeDir }, fs: nodeFs };
      const redacted = await prepareAgentTraceChange(context, {
        action: "enable",
        level: "redacted",
        hostKinds: ["codex"],
        endpoint: ENDPOINT,
        preparedChanges,
      });
      await preparedChanges.commit(redacted.changeId);
      expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).toContain(
        "https://logs.example/v1/logs",
      );

      await expect(
        prepareAgentTraceChange(context, {
          action: "enable",
          level: "tool-activity",
          hostKinds: ["codex"],
          endpoint: ENDPOINT,
          preparedChanges,
        }),
      ).rejects.toBeInstanceOf(AgentTraceConflictError);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("updates both hosts atomically using only the supplied loopback endpoint", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-both-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      const prepared = await prepareAgentTraceChange(
        { env: { homeDir }, fs: nodeFs },
        {
          action: "enable",
          hostKinds: ["claude-code", "codex"],
          endpoint: ENDPOINT,
          preparedChanges,
        },
      );
      await preparedChanges.commit(prepared.changeId);

      expect(await readFile(join(homeDir, ".claude", "settings.json"), "utf8")).toContain(ENDPOINT);
      expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).toContain(ENDPOINT);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("rolls back a multi-host revision conflict and removes transaction artifacts", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-conflict-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      const controlDir = join(homeDir, ".ratel");
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir }),
      });
      const prepared = await prepareAgentTraceChange(
        { env: { homeDir }, fs: nodeFs },
        {
          action: "enable",
          hostKinds: ["claude-code", "codex"],
          endpoint: ENDPOINT,
          preparedChanges,
        },
      );
      await mkdir(join(homeDir, ".codex"), { recursive: true });
      await writeFile(join(homeDir, ".codex", "config.toml"), "# external edit\n");

      await expect(preparedChanges.commit(prepared.changeId)).rejects.toMatchObject({
        code: "MUTATION_CONFLICT",
        reason: "revision_conflict",
      });
      await expect(readFile(join(homeDir, ".claude", "settings.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(homeDir, ".codex", "config.toml"), "utf8")).toBe(
        "# external edit\n",
      );
      expect(await readdir(join(controlDir, "transactions"))).toEqual([]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("does not prepare any writes when one selected config is malformed", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-agent-traces-invalid-"));
    try {
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      await mkdir(join(homeDir, ".codex"), { recursive: true });
      await writeFile(join(homeDir, ".codex", "config.toml"), "[otel\n");
      const preparedChanges = createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
      });
      await expect(
        prepareAgentTraceChange(
          { env: { homeDir }, fs: nodeFs },
          {
            action: "enable",
            hostKinds: ["claude-code", "codex"],
            endpoint: ENDPOINT,
            preparedChanges,
          },
        ),
      ).rejects.toMatchObject({ code: "AGENT_TRACE_INVALID" });
      await expect(readFile(join(homeDir, ".claude", "settings.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
