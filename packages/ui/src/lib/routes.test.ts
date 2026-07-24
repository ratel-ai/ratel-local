import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "../routeTree.gen";

describe("URL-scoped route tree", () => {
  it.each([
    ["/all", "/all", {}],
    ["/global/skills", "/global/$", { _splat: "skills" }],
    [
      "/projects/prj_123/tools/user/github",
      "/projects/$projectId/$",
      { _splat: "tools/user/github", projectId: "prj_123" },
    ],
  ])("matches %s", async (path, routeId, params) => {
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [path] }),
      routeTree,
    });
    await router.load();

    const match = router.state.matches.at(-1);
    expect(match?.routeId).toBe(routeId);
    expect(match?.params).toMatchObject(params);
  });
});
