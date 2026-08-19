import { describe, expect, it } from "vitest";
import { projectsFromResponse } from "./projects";

describe("projectsFromResponse", () => {
  it("accepts the versioned API envelope and rejects malformed records", () => {
    expect(
      projectsFromResponse({
        projects: [
          {
            projectId: "prj_1",
            canonicalRoot: "/work/one",
            displayName: "One",
            available: true,
            clientCount: 2,
          },
          { id: 42, canonicalRoot: "/invalid" },
        ],
      }),
    ).toEqual([
      {
        id: "prj_1",
        canonicalRoot: "/work/one",
        displayName: "One",
        available: true,
        clientCount: 2,
      },
    ]);
  });

  it("also accepts an array during the compatibility window", () => {
    expect(projectsFromResponse([{ id: "prj_1", canonicalRoot: "/work/one" }])).toHaveLength(1);
  });
});
