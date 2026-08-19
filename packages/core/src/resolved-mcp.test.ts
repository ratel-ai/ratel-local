import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectId } from "./context.js";
import { resolveMcpEntries } from "./resolved-mcp.js";

describe("resolveMcpEntries", () => {
  it("preserves provenance while project entries shadow user entries", () => {
    const projectId = "prj_example" as ProjectId;
    const result = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/workspace/repo",
      documents: [
        {
          ref: { scope: "user" },
          config: {
            mcpServers: {
              linear: { type: "http", url: "https://user.example/mcp" },
              filesystem: { type: "stdio", command: "node", args: ["server.js"] },
            },
          },
        },
        {
          ref: { scope: "project", projectId },
          config: {
            mcpServers: {
              linear: { type: "http", url: "https://project.example/mcp" },
            },
          },
        },
      ],
    });

    expect(result.map(({ name, owner, status }) => [name, owner.scope, status])).toEqual([
      ["filesystem", "user", "effective"],
      ["linear", "project", "effective"],
      ["linear", "user", "shadowed"],
    ]);
    expect(result.find((entry) => entry.name === "filesystem")?.runtimeCwd).toBe("/workspace/repo");
    expect(result.find((entry) => entry.owner.scope === "project")?.oauthKey.path).toMatch(
      new RegExp(
        `^${escapeRegex(join("/home/u", ".ratel", "oauth", "projects", projectId, "project"))}/`,
      ),
    );
  });

  it("shares inherited user OAuth while isolating project owners", () => {
    const projectA = "prj_a" as ProjectId;
    const projectB = "prj_b" as ProjectId;
    const userDocument = {
      ref: { scope: "user" as const },
      config: { mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } } },
    };
    const inheritedA = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/a",
      documents: [userDocument],
    })[0];
    const inheritedB = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/b",
      documents: [userDocument],
    })[0];
    const overrideA = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/a",
      documents: [
        userDocument,
        {
          ref: { scope: "project", projectId: projectA },
          config: {
            mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
          },
        },
      ],
    }).find(({ status }) => status === "effective");
    const overrideB = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/b",
      documents: [
        userDocument,
        {
          ref: { scope: "project", projectId: projectB },
          config: {
            mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
          },
        },
      ],
    }).find(({ status }) => status === "effective");

    expect(inheritedA.oauthKey).toEqual(inheritedB.oauthKey);
    expect(overrideA?.oauthKey.path).not.toBe(overrideB?.oauthKey.path);
    expect(overrideA?.oauthKey.path).not.toBe(inheritedA.oauthKey.path);
  });

  it("fingerprints the effective URL after expanding daemon environment placeholders", () => {
    const document = {
      ref: { scope: "user" as const },
      config: {
        mcpServers: {
          remote: { type: "http", url: ["https://$", "{MCP_HOST}/mcp"].join("") },
        },
      },
    };

    const first = resolveMcpEntries({
      homeDir: "/home/u",
      documents: [document],
      env: { MCP_HOST: "first.example" },
    })[0];
    const second = resolveMcpEntries({
      homeDir: "/home/u",
      documents: [document],
      env: { MCP_HOST: "second.example" },
    })[0];

    expect(first?.oauthKey.path).toBe(second?.oauthKey.path);
    expect(first?.oauthKey.fingerprint).not.toBe(second?.oauthKey.fingerprint);
  });

  it("keeps a valid fallback effective when a more specific absolute cwd is invalid", () => {
    const projectId = "prj_example" as ProjectId;
    const result = resolveMcpEntries({
      homeDir: "/home/u",
      projectRoot: "/workspace/repo",
      pathExists: (path) => path !== "/missing/project-cwd",
      documents: [
        {
          ref: { scope: "user" },
          config: {
            mcpServers: { review: { type: "stdio", command: "review-server" } },
          },
        },
        {
          ref: { scope: "project", projectId },
          config: {
            mcpServers: {
              review: {
                type: "stdio",
                command: "review-server",
                cwd: "/missing/project-cwd",
              },
            },
          },
        },
      ],
    });

    expect(result.map(({ owner, status }) => [owner.scope, status])).toEqual([
      ["user", "effective"],
      ["project", "invalid"],
    ]);
    expect(result[1]?.diagnostics).toEqual([
      {
        code: "mcp-cwd-missing",
        message: "configured absolute cwd does not exist: /missing/project-cwd",
      },
    ]);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
