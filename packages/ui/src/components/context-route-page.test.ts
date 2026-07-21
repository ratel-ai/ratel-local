import { afterEach, describe, expect, it, vi } from "vitest";
import { loadContextRouteData } from "./context-route-page";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("context route data preloading", () => {
  it("preloads agent hosts and discovered skills for a project Agent Setup route", async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          authorization: new Headers(init?.headers).get("Authorization"),
          url,
        });
        if (url.startsWith("/api/agent-hosts")) {
          return Response.json({ hosts: [{ kind: "codex", displayName: "Codex" }] });
        }
        if (url.startsWith("/api/config")) {
          return Response.json({
            backups: [{ action: "add", createdAt: "2026-07-21", entries: [] }],
          });
        }
        return Response.json({
          available: [],
          codexDir: "",
          discovered: [{ candidateId: "candidate-1", id: "review", source: "codex" }],
          managed: [],
          managedDir: "",
          nativeDir: "",
          problems: [],
        });
      }),
    );

    const result = await loadContextRouteData({
      context: { kind: "project", projectId: "project/a" },
      signal: new AbortController().signal,
      subpath: "agent-setup",
      token: "secret",
    });

    expect(requests).toEqual([
      {
        authorization: "Bearer secret",
        url: "/api/agent-hosts?projectId=project%2Fa",
      },
      {
        authorization: "Bearer secret",
        url: "/api/skills?projectId=project%2Fa",
      },
      {
        authorization: "Bearer secret",
        url: "/api/config?projectId=project%2Fa",
      },
    ]);
    expect(result.agentSetup?.hosts).toEqual([{ kind: "codex", displayName: "Codex" }]);
    expect(result.agentSetup?.available).toEqual([
      {
        candidateId: "candidate-1",
        description: "Discovered native skill",
        id: "review",
        name: "review",
        source: "codex",
        tags: [],
      },
    ]);
    expect(result.agentSetup?.backups).toEqual([
      { action: "add", createdAt: "2026-07-21", entries: [] },
    ]);
  });

  it("does not fetch for unrelated context pages", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadContextRouteData({
        context: { kind: "global" },
        signal: new AbortController().signal,
        subpath: "skills",
        token: "secret",
      }),
    ).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
