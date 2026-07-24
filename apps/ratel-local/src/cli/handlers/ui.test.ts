import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import type { HandlerCtx } from "./types.js";
import { runUi } from "./ui.js";

describe("runUi", () => {
  it("opens the persistent daemon UI when no standalone port is requested", async () => {
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

  it("wires agent and skill import control planes into the standalone UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-ui-handler-"));
    const homeDir = join(root, "home");
    const skillDir = join(homeDir, ".agents", "skills", "demo-skill");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { demo: { type: "stdio", command: "echo" } } }),
    );
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\n\nUse the demo skill.\n",
    );

    const parsed: ParsedArgs = {
      group: "ui",
      configPaths: [],
      rest: [],
      extras: [],
      flags: { open: false, port: "0" },
    };
    const logs: string[] = [];
    const ctx: HandlerCtx = {
      argv: parsed,
      env: { homeDir },
      fs: nodeFs,
      log: (message) => logs.push(message),
      prompts: silentPromptAdapter(),
      installAgentPlugin: async () => ({ installed: false, message: "not installed in test" }),
    };
    const handle = await runUi(parsed, ctx, ctx.log);

    try {
      const loggedUrl = logs
        .find((message) => message.startsWith("[ratel] UI running at "))
        ?.slice("[ratel] UI running at ".length);
      expect(loggedUrl).toBeTruthy();
      expect(logs).toContain(
        "[ratel] standalone UI: live daemon client and gateway state is unavailable",
      );
      const url = new URL(loggedUrl as string);
      const token = url.searchParams.get("t");
      expect(token).toBeTruthy();
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      const agentResponse = await fetch(`${url.origin}/api/agents/import/prepare`, {
        method: "POST",
        headers,
        body: JSON.stringify({ hostKind: "claude-code" }),
      });
      expect(agentResponse.status).toBe(200);
      const agentChange = (await agentResponse.json()) as {
        changeId: string;
        preview: { candidates: Array<{ name: string }> };
      };
      expect(agentChange.preview.candidates.map(({ name }) => name)).toEqual(["demo"]);

      const skillsResponse = await fetch(`${url.origin}/api/skills`, { headers });
      expect(skillsResponse.status).toBe(200);
      const skills = (await skillsResponse.json()) as {
        discovered: Array<{ candidateId: string; id: string }>;
      };
      const skill = skills.discovered.find(({ id }) => id === "demo-skill");
      expect(skill).toBeTruthy();

      const skillResponse = await fetch(`${url.origin}/api/skills/import/prepare`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          selections: [
            {
              candidateId: skill?.candidateId,
              targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
            },
          ],
        }),
      });
      expect(skillResponse.status).toBe(200);
    } finally {
      await handle.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
