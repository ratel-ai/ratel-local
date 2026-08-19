import { nodeFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import type { HandlerCtx } from "./types.js";
import { runUi } from "./ui.js";

describe("runUi", () => {
  it("opens the persistent daemon UI", async () => {
    const logs: string[] = [];
    const open = vi.fn();
    const parsed: ParsedArgs = {
      group: "ui",
      configPaths: [],
      rest: [],
      extras: [],
      flags: {},
    };
    const ctx: HandlerCtx = {
      argv: parsed,
      env: { homeDir: "/home/u" },
      fs: nodeFs,
      log: (message) => logs.push(message),
      prompts: silentPromptAdapter(),
    };

    const handle = await runUi(parsed, ctx, ctx.log, {
      open,
      daemonRequest: async (path, init) => {
        expect({ path, method: init?.method }).toEqual({
          path: "/api/ui/sessions",
          method: "POST",
        });
        return new Response(JSON.stringify({ url: "http://127.0.0.1:5731/global/?t=session" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    expect(open).toHaveBeenCalledWith("http://127.0.0.1:5731/global/?t=session");
    expect(logs).toEqual(["[ratel] opened the persistent daemon UI"]);
    await handle.shutdown();
  });

  it("requires the persistent daemon", async () => {
    const parsed: ParsedArgs = {
      group: "ui",
      configPaths: [],
      rest: [],
      extras: [],
      flags: { open: false },
    };
    const ctx: HandlerCtx = {
      argv: parsed,
      env: { homeDir: "/home/u" },
      fs: nodeFs,
      log: () => {},
      prompts: silentPromptAdapter(),
    };

    await expect(runUi(parsed, ctx, ctx.log, { daemonRequest: async () => null })).rejects.toThrow(
      /daemon is not running.*ratel-local setup/,
    );
  });

  it("rejects the removed standalone port option", async () => {
    const parsed: ParsedArgs = {
      group: "ui",
      configPaths: [],
      rest: [],
      extras: [],
      flags: { port: "7331" },
    };
    const ctx: HandlerCtx = {
      argv: parsed,
      env: { homeDir: "/home/u" },
      fs: nodeFs,
      log: () => {},
      prompts: silentPromptAdapter(),
    };
    const daemonRequest = vi.fn();

    await expect(runUi(parsed, ctx, ctx.log, { daemonRequest })).rejects.toThrow(
      /ui --port.*no longer supported/,
    );
    expect(daemonRequest).not.toHaveBeenCalled();
  });
});
