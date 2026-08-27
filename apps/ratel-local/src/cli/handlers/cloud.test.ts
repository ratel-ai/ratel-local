import type { BackupFs, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import type { CloudSettings } from "../../cloud/settings.js";
import { silentPromptAdapter } from "../prompts.js";
import { runCloud } from "./cloud.js";
import type { HandlerCtx } from "./types.js";

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
  verb: "add" | "use" | "list",
  rest: string[] = [],
  flags: Record<string, string | boolean | string[]> = {},
  prompts = silentPromptAdapter(),
) {
  const output: string[] = [];
  const ctx: HandlerCtx = {
    argv: { group: "cloud", verb, configPaths: [], rest, extras: [], flags },
    env: { homeDir: "/home/u" },
    fs: new MemFs(),
    log: (message) => output.push(message),
    prompts,
  };
  return { ctx, output };
}

/** A prompt adapter that answers the masked password question. */
function answering(answer: string | symbol) {
  const adapter = silentPromptAdapter();
  return { ...adapter, password: async () => answer };
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
  tracesEndpoint: "https://cloud.ratel.sh/api/v1/traces",
  default: "personal",
  profiles: { personal: { apiKey: "rtl_personal" } },
};

describe("cloud add", () => {
  it("stores the first profile and makes it the default", async () => {
    const { ctx, output } = context("add", ["personal"], {}, answering("rtl_new"));
    const target = store();

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([
      {
        tracesEndpoint: "https://cloud.ratel.sh/api/v1/traces",
        default: "personal",
        profiles: { personal: { apiKey: "rtl_new" } },
      },
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

  it("stores nothing when the prompt is cancelled or empty", async () => {
    for (const answer of [Symbol.for("clack:cancel"), ""]) {
      const { ctx } = context("add", ["acme"], {}, answering(answer));
      const target = store(EXISTING);
      await runCloud(ctx, { store: target });
      expect(target.saved).toEqual([]);
    }
  });

  it("requires a profile name", async () => {
    const { ctx } = context("add", []);
    await expect(runCloud(ctx, { store: store() })).rejects.toThrow(/requires a profile name/);
  });
});

describe("cloud use", () => {
  it("writes the selection through the config mutator", async () => {
    const mutateCloud = vi.fn(async () => ({ path: "/repo/.ratel/config.json" }));
    const { ctx, output } = context("use", ["personal"], { scope: "project" });

    await runCloud(ctx, { store: store(EXISTING), mutateCloud });

    expect(mutateCloud).toHaveBeenCalledWith({ scope: "project", profile: "personal" });
    expect(output.join("\n")).toContain("/repo/.ratel/config.json");
  });

  it("defaults to project scope", async () => {
    const mutateCloud = vi.fn(async () => ({ path: "/repo/.ratel/config.json" }));
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
