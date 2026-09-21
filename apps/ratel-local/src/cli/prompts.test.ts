import { describe, expect, it } from "vitest";
import { createCliOutput } from "./output/index.js";
import { defaultPromptAdapter, PromptUnavailableError } from "./prompts.js";

describe("noninteractive prompts", () => {
  const environment = { interactive: false, prompt: false, color: false, width: 80 };

  it("fails explicitly instead of approving, cancelling silently, or waiting for input", async () => {
    const prompts = defaultPromptAdapter({ environment });
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
    expect(defaultPromptAdapter({ environment }).canPrompt()).toBe(false);
    expect(
      defaultPromptAdapter({ environment: { ...environment, prompt: true } }).canPrompt(),
    ).toBe(true);
  });

  it("keeps notes and progress visible in redirected runs", () => {
    const lines: string[] = [];
    const output = createCliOutput({ environment, write: (line) => lines.push(line) });
    const prompts = defaultPromptAdapter({ environment, output });
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
