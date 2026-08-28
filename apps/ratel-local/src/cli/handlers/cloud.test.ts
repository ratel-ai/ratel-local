import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupFs, type JsonFs, ratelConfigPath } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "../../cloud/settings.js";
import { CANCEL_SYMBOL, silentPromptAdapter } from "../prompts.js";
import { runCloud } from "./cloud.js";
import type { CliCloudMutationRequest, HandlerCtx } from "./types.js";

class MemFs implements BackupFs, JsonFs {
  constructor(private readonly documents: Record<string, unknown> = {}) {}
  async read(path: string) {
    const document = this.documents[path];
    return document === undefined ? null : JSON.stringify(document);
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
  verb: "add" | "use" | "list",
  rest: string[] = [],
  flags: Record<string, string | boolean | string[]> = {},
  prompts = silentPromptAdapter(),
  documents: Record<string, unknown> = {},
) {
  const output: string[] = [];
  const ctx: HandlerCtx = {
    argv: { group: "cloud", verb, configPaths: [], rest, extras: [], flags },
    env: { homeDir: "/home/u", projectRoot: "/repo" },
    fs: new MemFs(documents),
    log: (message) => output.push(message),
    prompts,
  };
  return { ctx, output };
}

function answering(answer: string | symbol) {
  const adapter = silentPromptAdapter();
  return { ...adapter, password: async () => answer, canPrompt: () => true };
}

function piped(answer: string | symbol) {
  return { ...answering(answer), canPrompt: () => false };
}

function store(initial?: CloudSettings) {
  const saved: CloudSettings[] = [];
  return {
    saved,
    load: async () => initial,
    save: async (settings: CloudSettings) => {
      saved.push(settings);
    },
  };
}

const EXISTING: CloudSettings = {
  default: "personal",
  profiles: { personal: { apiKey: "rtl_personal" } },
};

describe("cloud add", () => {
  it("stores the first profile and makes it the default", async () => {
    const { ctx, output } = context("add", ["personal"], {}, answering("rtl_new"));
    const target = store();

    await runCloud(ctx, { store: target });

    // Nothing about endpoints: a first credential does not pin a deployment.
    expect(target.saved).toEqual([
      { default: "personal", profiles: { personal: { apiKey: "rtl_new" } } },
    ]);
    // A single-project setup never has to think about selection.
    expect(output.join("\n")).toContain('"personal" is the default profile');
  });

  it("adds a second profile, keeps the first, and does not steal the default", async () => {
    const { ctx, output } = context("add", ["acme"], {}, answering("rtl_acme"));
    const target = store(EXISTING);

    await runCloud(ctx, { store: target });

    expect(target.saved[0]?.default).toBe("personal");
    expect(target.saved[0]?.profiles).toEqual({
      personal: { apiKey: "rtl_personal" },
      acme: { apiKey: "rtl_acme" },
    });
    expect(output.join("\n")).toContain("ratel-local cloud use acme");
  });

  it("tells a running daemon to re-read the store", async () => {
    const reloadDaemon = vi.fn(async () => "reloaded" as const);
    const { ctx, output } = context("add", ["acme"], {}, answering("rtl_acme"));

    await runCloud(ctx, { store: store(EXISTING), reloadDaemon });

    expect(reloadDaemon).toHaveBeenCalledOnce();
    expect(output.join("\n")).not.toContain("daemon restart");
  });

  it("asks for a restart only when a live daemon refused the reload", async () => {
    // No daemon is the first-run case: it reads the store when it starts, so
    // telling the user to restart one names something that does not exist.
    const absent = context("add", ["acme"], {}, answering("rtl_acme"));
    await runCloud(absent.ctx, { store: store(EXISTING), reloadDaemon: async () => "no-daemon" });
    expect(absent.output.join("\n")).not.toContain("daemon restart");

    const refused = context("add", ["acme"], {}, answering("rtl_acme"));
    await runCloud(refused.ctx, { store: store(EXISTING), reloadDaemon: async () => "failed" });
    expect(refused.output.join("\n")).toContain("ratel-local daemon restart");
  });

  it("stores nothing when the prompt is cancelled", async () => {
    const { ctx } = context("add", ["acme"], {}, answering(CANCEL_SYMBOL));
    const target = store(EXISTING);

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([]);
  });

  it("refuses to run without a terminal, whatever the prompt returns", async () => {
    // Every shape the adapter can return, including one it never would.
    for (const answer of [CANCEL_SYMBOL, "", "rtl_piped"]) {
      const { ctx } = context("add", ["acme"], {}, piped(answer));
      const target = store(EXISTING);

      await expect(runCloud(ctx, { store: target })).rejects.toThrow(/without a terminal/);
      expect(target.saved).toEqual([]);
    }
  });

  it("fails when a terminal answers with nothing", async () => {
    const { ctx } = context("add", ["acme"], {}, answering(""));
    const target = store(EXISTING);

    await expect(runCloud(ctx, { store: target })).rejects.toThrow(/no API key was entered/);
    expect(target.saved).toEqual([]);
  });

  it("reports the legacy store migration to the user, not only to the daemon", async () => {
    // No injected store: the one `runCloud` builds is what carries the logger.
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-"));
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await writeFile(
      join(homeDir, ".ratel", "cloud-traces.json"),
      JSON.stringify({ endpoint: "https://cloud.ratel.sh/api/v1/traces", apiKey: "rtl_legacy" }),
    );
    const { ctx, output } = context("list", [], {});
    ctx.env = { homeDir };

    await runCloud(ctx, { processEnv: {} });

    const printed = output.join("\n");
    expect(printed).toContain(join(homeDir, ".ratel", "cloud-traces.json"));
    expect(printed).toContain("still holds a key");
    expect(printed).toContain("Cloud skills here:");
    expect(printed).not.toContain("rtl_legacy");
    await rm(homeDir, { recursive: true, force: true });
  });

  it("requires a profile name", async () => {
    const { ctx } = context("add", []);
    await expect(runCloud(ctx, { store: store() })).rejects.toThrow(/requires a profile name/);
  });
});

describe("cloud use", () => {
  it("writes the selection through the config mutator", async () => {
    const mutateCloud = vi.fn(async (_request: CliCloudMutationRequest) => ({
      path: "/repo/.ratel/config.json",
    }));
    const { ctx, output } = context("use", ["personal"], { scope: "project" });

    await runCloud(ctx, { store: store(EXISTING), mutateCloud });

    expect(mutateCloud).toHaveBeenCalledWith({ scope: "project", profile: "personal" });
    expect(output.join("\n")).toContain("/repo/.ratel/config.json");
  });

  it("defaults to project scope", async () => {
    const mutateCloud = vi.fn(async (_request: CliCloudMutationRequest) => ({
      path: "/repo/.ratel/config.json",
    }));
    const { ctx } = context("use", ["personal"]);
    await runCloud(ctx, { store: store(EXISTING), mutateCloud });
    expect(mutateCloud.mock.calls[0]?.[0]).toMatchObject({ scope: "project" });
  });

  it("refuses a profile that is not stored, and lists what is", async () => {
    const mutateCloud = vi.fn();
    const { ctx } = context("use", ["ghost"]);

    await expect(runCloud(ctx, { store: store(EXISTING), mutateCloud })).rejects.toThrow(
      /no Cloud profile named "ghost".*stored profiles: personal/s,
    );
    expect(mutateCloud).not.toHaveBeenCalled();
  });
});

describe("cloud list", () => {
  it("marks the default and the environment override", async () => {
    const { ctx, output } = context("list");
    await runCloud(ctx, {
      store: store({
        ...EXISTING,
        profiles: { personal: { apiKey: "a" }, acme: { apiKey: "b" } },
      }),
      processEnv: { RATEL_PROFILE: "acme" },
    });
    expect(output.join("\n")).toContain("acme  (RATEL_PROFILE)");
    expect(output.join("\n")).toContain("personal  (default)");
  });

  it("says how to start when nothing is stored", async () => {
    const { ctx, output } = context("list");
    await runCloud(ctx, { store: store(), processEnv: {} });
    expect(output.join("\n")).toContain("ratel-local cloud add <profile>");
  });
});

const TWO_PROFILES: CloudSettings = {
  default: "personal",
  profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
};

const projectConfig = (profile: string) => ({
  [ratelConfigPath("project", { homeDir: "/home/u", projectRoot: "/repo" })]: {
    cloud: { profile },
  },
});

describe("cloud list bindings", () => {
  it("names the profile this directory selects and the file that selects it", async () => {
    const { ctx, output } = context("list", [], {}, silentPromptAdapter(), projectConfig("acme"));

    await runCloud(ctx, { store: store(TWO_PROFILES), processEnv: {} });

    const printed = output.join("\n");
    expect(printed).toContain("acme  (cloud.profile)");
    expect(printed).toContain("personal  (default)");
    expect(printed).toContain(
      'Cloud skills here: "acme" (cloud.profile in /repo/.ratel/config.json)',
    );
    expect(printed).toContain("Traces do not follow cloud.profile");
  });

  it("falls back to the store default when no scope names a profile", async () => {
    const { ctx, output } = context("list", [], {});

    await runCloud(ctx, { store: store(TWO_PROFILES), processEnv: {} });

    expect(output.join("\n")).toContain('Cloud skills here: "personal" (store default)');
    expect(output.join("\n")).not.toContain("Traces do not follow");
  });

  it("survives a config broken by something else entirely", async () => {
    const { ctx, output } = context("list", [], {}, silentPromptAdapter(), {
      [ratelConfigPath("project", { homeDir: "/home/u", projectRoot: "/repo" })]: {
        retrieval: { method: "bogus" },
      },
    });

    await runCloud(ctx, { store: store(TWO_PROFILES), processEnv: {} });

    const printed = output.join("\n");
    expect(printed).toContain("warning: ignoring /repo/.ratel/config.json");
    expect(printed).toContain('Cloud skills here: "personal" (store default)');
  });

  it("shows each endpoint with where it came from", async () => {
    const { ctx, output } = context("list", [], {});

    await runCloud(ctx, {
      store: store({
        ...TWO_PROFILES,
        baseUrl: "https://staging.ratel.sh",
        catalogEndpoint: "https://scratch.example.test/api/v1/catalog",
      }),
      processEnv: {},
    });

    const printed = output.join("\n");
    expect(printed).toMatch(/traces\s+https:\/\/staging\.ratel\.sh\/api\/v1\/traces\s+baseUrl/);
    expect(printed).toMatch(
      /catalog\s+https:\/\/scratch\.example\.test\/api\/v1\/catalog\s+catalogEndpoint/,
    );
  });

  it("warns when the selected profile is not stored", async () => {
    const { ctx, output } = context("list", [], {}, silentPromptAdapter(), projectConfig("gone"));

    await runCloud(ctx, { store: store(TWO_PROFILES), processEnv: {} });

    expect(output.join("\n")).toContain('no profile named "gone" is stored');
  });

  it("reports the RATEL_PROFILE selection when no scope overrides it", async () => {
    const { ctx, output } = context("list", [], {});

    await runCloud(ctx, { store: store(TWO_PROFILES), processEnv: { RATEL_PROFILE: "acme" } });

    expect(output.join("\n")).toContain('Cloud skills here: "acme" (RATEL_PROFILE)');
  });
});
