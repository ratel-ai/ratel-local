import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import type { HandlerCtx } from "./types.js";
import { runUi } from "./ui.js";

describe("runUi", () => {
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
