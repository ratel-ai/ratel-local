import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupFs, type JsonFs, ratelConfigPath } from "@ratel-ai/ratel-local-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type CloudSettings, CloudSettingsStore, cloudSettingsPath } from "../../cloud/settings.js";
import { CANCEL_SYMBOL, silentPromptAdapter } from "../prompts.js";
import { runCloud } from "./cloud.js";
import type { CliCloudMutationRequest, HandlerCtx } from "./types.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tempHomes: string[] = [];

afterAll(async () => {
  await Promise.all(tempHomes.map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-cli-"));
  tempHomes.push(homeDir);
  await mkdir(join(homeDir, ".ratel"), { recursive: true, mode: 0o700 });
  return homeDir;
}
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
  verb: "add" | "use" | "list" | "status" | "test" | "remove",
  rest: string[] = [],
  flags: Record<string, string | boolean | string[]> = {},
  prompts = silentPromptAdapter(),
  documents: Record<string, unknown> = {},
  homeDir = "/home/u",
) {
  const output: string[] = [];
  const ctx: HandlerCtx = {
    argv: { group: "cloud", verb, configPaths: [], rest, extras: [], flags },
    env: { homeDir, projectRoot: "/repo" },
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
  let current = initial;
  return {
    saved,
    load: async () => current,
    update: async (mutator: (current: CloudSettings) => CloudSettings | Promise<CloudSettings>) => {
      const next = await mutator(current ?? { profiles: {} });
      current = next;
      saved.push(next);
      return next;
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
    expect(output.join("\n")).toContain("ratel cloud use acme");
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

  it("requires a profile name", async () => {
    const { ctx } = context("add", []);
    await expect(runCloud(ctx, { store: store() })).rejects.toThrow(/requires a profile name/);
  });

  it("keeps a profile stored while this add was prompting", async () => {
    const slowPassword = deferred<string>();
    const slowPrompts = {
      ...silentPromptAdapter(),
      canPrompt: () => true,
      password: async () => slowPassword.promise,
    };
    const slow = context("add", ["slow"], {}, slowPrompts);
    const target = store();
    const slowRun = runCloud(slow.ctx, { store: target });

    const fast = context("add", ["fast"], {}, answering("rtl_fast"));
    await runCloud(fast.ctx, { store: target });
    expect(fast.output.join("\n")).toContain('"fast" is the default profile');

    slowPassword.resolve("rtl_slow");
    await slowRun;

    expect(target.saved.at(-1)).toEqual({
      default: "fast",
      profiles: {
        fast: { apiKey: "rtl_fast" },
        slow: { apiKey: "rtl_slow" },
      },
    });
    expect(slow.output.join("\n")).toContain("ratel cloud use slow");
  });

  it("two adds that finish together both land", async () => {
    const homeDir = await tempHome();
    const target = new CloudSettingsStore(cloudSettingsPath(homeDir));
    await Promise.all([
      runCloud(context("add", ["a"], {}, answering("rtl_a"), {}, homeDir).ctx, { store: target }),
      runCloud(context("add", ["b"], {}, answering("rtl_b"), {}, homeDir).ctx, { store: target }),
    ]);

    const loaded = await target.load();
    expect(loaded?.profiles).toEqual({ a: { apiKey: "rtl_a" }, b: { apiKey: "rtl_b" } });
    expect(loaded?.default === "a" || loaded?.default === "b").toBe(true);
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
  it("marks the store default", async () => {
    const { ctx, output } = context("list");
    await runCloud(ctx, {
      store: store({
        ...EXISTING,
        profiles: { personal: { apiKey: "a" }, acme: { apiKey: "b" } },
      }),
    });
    expect(output.join("\n")).toContain("personal  (default)");
    expect(output.join("\n")).toContain("acme");
  });

  it("says how to start when nothing is stored", async () => {
    const { ctx, output } = context("list");
    await runCloud(ctx, { store: store() });
    expect(output.join("\n")).toContain("ratel cloud add <profile>");
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

    await runCloud(ctx, { store: store(TWO_PROFILES) });

    const printed = output.join("\n");
    expect(printed).toContain("acme  (cloud.profile)");
    expect(printed).toContain("personal  (default)");
    expect(printed).toContain(
      'Cloud skills here: "acme" (cloud.profile in /repo/.ratel/config.json)',
    );
  });

  it("falls back to the store default when no scope names a profile", async () => {
    const { ctx, output } = context("list", [], {});

    await runCloud(ctx, { store: store(TWO_PROFILES) });

    expect(output.join("\n")).toContain('Cloud skills here: "personal" (store default)');
  });

  it("survives a config broken by something else entirely", async () => {
    const { ctx, output } = context("list", [], {}, silentPromptAdapter(), {
      [ratelConfigPath("project", { homeDir: "/home/u", projectRoot: "/repo" })]: {
        retrieval: { method: "bogus" },
      },
    });

    await runCloud(ctx, { store: store(TWO_PROFILES) });

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
    });

    expect(output.join("\n")).toMatch(
      /catalog\s+https:\/\/scratch\.example\.test\/api\/v1\/catalog\s+catalogEndpoint/,
    );
  });

  it("warns when the selected profile is not stored", async () => {
    const { ctx, output } = context("list", [], {}, silentPromptAdapter(), projectConfig("gone"));

    await runCloud(ctx, { store: store(TWO_PROFILES) });

    expect(output.join("\n")).toContain('no profile named "gone" is stored');
  });
});

describe("cloud status", () => {
  it("prints the resolved profile, source, catalog, and ready state", async () => {
    const { ctx, output } = context("status", [], {}, silentPromptAdapter(), projectConfig("acme"));

    await runCloud(ctx, { store: store(TWO_PROFILES) });

    const printed = output.join("\n");
    expect(printed).toContain('profile "acme"');
    expect(printed).toContain("cloud.profile in /repo/.ratel/config.json");
    expect(printed).toMatch(/catalog\s+https:\/\/cloud\.ratel\.sh\/api\/v1\/catalog\s+default/);
    expect(printed).toContain("state ready");
    expect(printed).not.toContain("rtl_");
  });

  it("falls back to the store default when nothing selects a profile", async () => {
    const { ctx, output } = context("status", [], {});

    await runCloud(ctx, { store: store(TWO_PROFILES) });

    const printed = output.join("\n");
    expect(printed).toContain('profile "personal"');
    expect(printed).toContain("store default");
    expect(printed).toContain("state ready");
  });

  it("fails when a config file names a profile that is not stored", async () => {
    const { ctx, output } = context("status", [], {}, silentPromptAdapter(), projectConfig("gone"));

    await expect(runCloud(ctx, { store: store(TWO_PROFILES) })).rejects.toThrow(
      /cloud\.profile in \/repo\/\.ratel\/config\.json.*gone.*cloud add gone/s,
    );
    expect(output.join("\n")).not.toContain("rtl_");
  });

  it("reports none when nothing is stored and nothing selects a profile", async () => {
    const { ctx, output } = context("status", [], {});

    await runCloud(ctx, { store: store() });

    const printed = output.join("\n");
    expect(printed).toContain("state none");
    expect(printed).toContain("ratel cloud add <profile>");
  });
});

const VALID_CATALOG = {
  catalogVersion: "v1",
  skills: [
    {
      id: "demo",
      name: "demo",
      description: "demo skill",
      tags: [],
      tools: [],
      metadata: {},
      body: "# secret body that must not print",
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("cloud test", () => {
  it("reports reachable and authorized for a valid catalog", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID_CATALOG));
    const { ctx, output } = context("test", ["personal"]);

    await runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch });

    const printed = output.join("\n");
    expect(printed).toContain("reachable yes");
    expect(printed).toContain("authorized yes");
    expect(printed).not.toContain("rtl_personal");
    expect(printed).not.toContain("secret body");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("separates reachability from a rejected key (%s)", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status }));
    const { ctx, output } = context("test", ["personal"]);

    await expect(
      runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/authorized no|HTTP/);

    const printed = output.join("\n");
    expect(printed).toContain("reachable yes");
    expect(printed).toContain("authorized no");
    expect(printed).toContain(`HTTP ${status}`);
    expect(printed).not.toContain("rtl_personal");
  });

  it("reports unreachable when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const { ctx, output } = context("test", ["personal"]);

    await expect(
      runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/reachable no|unavailable/i);

    const printed = output.join("\n");
    expect(printed).toContain("reachable no");
    expect(printed).toContain("authorized unknown");
    expect(printed).not.toContain("rtl_personal");
  });

  it("reports unreachable for a non-auth HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 500 }));
    const { ctx, output } = context("test", ["personal"]);

    await expect(
      runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/reachable no|unavailable/i);

    const printed = output.join("\n");
    expect(printed).toContain("reachable no");
    expect(printed).toContain("authorized unknown");
  });

  it("reports a malformed catalog separately from auth", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
    const { ctx, output } = context("test", ["personal"]);

    await expect(
      runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/catalog malformed/i);

    const printed = output.join("\n");
    expect(printed).toContain("reachable yes");
    expect(printed).toContain("authorized yes");
    expect(printed).not.toContain("rtl_personal");
  });

  it("refuses a profile that is not stored without calling the network", async () => {
    const fetchImpl = vi.fn();
    const { ctx } = context("test", ["ghost"]);

    await expect(
      runCloud(ctx, { store: store(EXISTING), fetch: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no Cloud profile named "ghost".*stored profiles: personal/s);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a profile name", async () => {
    const { ctx } = context("test", []);
    await expect(runCloud(ctx, { store: store(EXISTING) })).rejects.toThrow(
      /requires a profile name/,
    );
  });
});

const userConfig = (profile: string) => ({
  [ratelConfigPath("user", { homeDir: "/home/u", projectRoot: "/repo" })]: {
    cloud: { profile },
  },
});

const localConfig = (profile: string) => ({
  [ratelConfigPath("local", { homeDir: "/home/u", projectRoot: "/repo" })]: {
    cloud: { profile },
  },
});

describe("cloud remove", () => {
  it("removes a non-selected, non-default profile", async () => {
    const { ctx, output } = context("remove", ["acme"]);
    const target = store(TWO_PROFILES);

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([
      { default: "personal", profiles: { personal: { apiKey: "rtl_personal" } } },
    ]);
    expect(output.join("\n")).toContain('Removed Cloud profile "acme"');
    expect(output.join("\n")).not.toContain("rtl_");
  });

  it("clears the store default when that profile is removed", async () => {
    const { ctx, output } = context("remove", ["personal"]);
    const target = store(TWO_PROFILES);

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([{ profiles: { acme: { apiKey: "rtl_acme" } } }]);
    expect(output.join("\n")).toContain("default was cleared");
    expect(output.join("\n")).not.toContain("rtl_");
  });

  it("removes the last profile and leaves an empty store", async () => {
    const { ctx } = context("remove", ["personal"]);
    const target = store(EXISTING);

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([{ profiles: {} }]);
  });

  it("refuses when this directory's project config still selects the profile", async () => {
    const { ctx } = context("remove", ["acme"], {}, silentPromptAdapter(), projectConfig("acme"));
    const target = store(TWO_PROFILES);

    await expect(runCloud(ctx, { store: target })).rejects.toThrow(
      /\/repo\/\.ratel\/config\.json.*this directory.*user\/project\/local/s,
    );
    expect(target.saved).toEqual([]);
  });

  it("refuses when a non-winning scope file still names the profile", async () => {
    const { ctx } = context("remove", ["personal"], {}, silentPromptAdapter(), {
      ...userConfig("personal"),
      ...projectConfig("acme"),
    });
    const target = store(TWO_PROFILES);

    await expect(runCloud(ctx, { store: target })).rejects.toThrow(
      /\/home\/u\/\.ratel\/config\.json.*this directory/s,
    );
    expect(target.saved).toEqual([]);
  });

  it("removes with --force even when this directory still selects the profile", async () => {
    const { ctx, output } = context(
      "remove",
      ["acme"],
      { force: true },
      silentPromptAdapter(),
      projectConfig("acme"),
    );
    const target = store(TWO_PROFILES);

    await runCloud(ctx, { store: target });

    expect(target.saved).toEqual([
      { default: "personal", profiles: { personal: { apiKey: "rtl_personal" } } },
    ]);
    expect(output.join("\n")).toContain('Removed Cloud profile "acme"');
    expect(output.join("\n")).not.toContain("rtl_");
  });

  it("refuses a profile that is not stored", async () => {
    const { ctx } = context("remove", ["ghost"]);
    const target = store(EXISTING);

    await expect(runCloud(ctx, { store: target })).rejects.toThrow(
      /no Cloud profile named "ghost"/,
    );
    expect(target.saved).toEqual([]);
  });

  it("refuses when the local scope names the profile", async () => {
    const { ctx } = context("remove", ["acme"], {}, silentPromptAdapter(), localConfig("acme"));
    const target = store(TWO_PROFILES);

    await expect(runCloud(ctx, { store: target })).rejects.toThrow(/config\.local\.json/);
    expect(target.saved).toEqual([]);
  });

  it("keeps a profile added while this remove was scanning scopes", async () => {
    const projectPath = ratelConfigPath("project", { homeDir: "/home/u", projectRoot: "/repo" });
    const holdRead = deferred();
    const readStarted = deferred();

    class GatedFs extends MemFs {
      override async read(path: string) {
        if (path === projectPath) {
          readStarted.resolve();
          await holdRead.promise;
        }
        return super.read(path);
      }
    }

    const documents = projectConfig("acme");
    const c = context("remove", ["personal"], {}, silentPromptAdapter(), documents);
    const ctx = { ...c.ctx, fs: new GatedFs(documents) };
    const target = store(TWO_PROFILES);
    const removing = runCloud(ctx, { store: target });
    await readStarted.promise;

    await runCloud(context("add", ["extra"], {}, answering("rtl_extra")).ctx, { store: target });
    holdRead.resolve();
    await removing;

    expect(target.saved.at(-1)).toEqual({
      profiles: {
        acme: { apiKey: "rtl_acme" },
        extra: { apiKey: "rtl_extra" },
      },
    });
    expect(c.output.join("\n")).toContain('Removed Cloud profile "personal"');
    expect(c.output.join("\n")).toContain("default was cleared");
  });
});
