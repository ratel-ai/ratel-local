import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRatelApi } from "./ratel-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestRatelApi", () => {
  it("applies the runtime context, authorization, and JSON body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestRatelApi(
        {
          context: { kind: "project", projectId: "project/a" },
          token: "secret",
        },
        "/api/skills",
        { body: { name: "review" }, method: "POST" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/skills?projectId=project%2Fa");
    expect(new Headers(init.headers)).toMatchObject(
      new Headers({
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      }),
    );
    expect(init.body).toBe('{"name":"review"}');
  });

  it("uses the API error message when a request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Skill not found" }, { status: 404 })),
    );

    await expect(
      requestRatelApi({ context: { kind: "global" }, token: "secret" }, "/api/skills/missing"),
    ).rejects.toThrow("Skill not found");
  });
});
