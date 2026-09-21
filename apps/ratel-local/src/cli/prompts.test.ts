import { describe, expect, it } from "vitest";
import { PLAIN } from "./output/environment.js";
import { createCliOutput } from "./output/index.js";
import { defaultPromptAdapter, PromptUnavailableError } from "./prompts.js";

describe("noninteractive prompts", () => {
  const environment = PLAIN;
  const output = createCliOutput({ environment, write: () => {} });

  it("fails explicitly instead of approving, cancelling silently, or waiting for input", async () => {
    const prompts = defaultPromptAdapter({ environment, output });
    await expect(prompts.confirm({ message: "Delete?" })).rejects.toBeInstanceOf(
      PromptUnavailableError,
    );
    await expect(prompts.text({ message: "Name?" })).rejects.toThrow("Name?");
    await expect(prompts.password({ message: "Key?" })).rejects.toBeInstanceOf(
      PromptUnavailableError,
    );
    await expect(prompts.select({ message: "Choose", options: [] })).rejects.toBeInstanceOf(
      PromptUnavailableError,
    );
    await expect(prompts.multiselect({ message: "Choose", options: [] })).rejects.toBeInstanceOf(
      PromptUnavailableError,
    );
  });

  it("reports whether questions can be asked from the same rule that blocks them", () => {
    expect(defaultPromptAdapter({ environment, output }).canPrompt()).toBe(false);
    expect(
      defaultPromptAdapter({ environment: { ...environment, prompt: true }, output }).canPrompt(),
    ).toBe(true);
  });

  it("keeps notes and progress visible in redirected runs", () => {
    const lines: string[] = [];
    const prompts = defaultPromptAdapter({
      environment,
      output: createCliOutput({ environment, write: (line) => lines.push(line) }),
    });
    prompts.intro("Setup");
    prompts.note("Ready to install", "Daemon");
    const progress = prompts.spinner();
    progress.start("Installing");
    progress.stop("Installed");
    prompts.outro("Done");
    expect(lines).toEqual([
      "Setup",
      "Daemon",
      "Ready to install",
      "Installing",
      "Installed",
      "[ok] Done",
    ]);
  });
});
