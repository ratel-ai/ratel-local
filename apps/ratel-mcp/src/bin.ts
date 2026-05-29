#!/usr/bin/env node
import { runCli } from "./cli/cli.js";
import { defaultPromptAdapter } from "./cli/prompts.js";

async function main() {
  const result = await runCli(process.argv.slice(2), {
    prompts: defaultPromptAdapter(),
  });

  if (!result.shutdown) return;

  const shutdown = result.shutdown;
  let shuttingDown = false;
  const onSignal = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[ratel-mcp] received ${signal}, shutting down`);
    try {
      await shutdown();
    } catch (err) {
      console.error(`[ratel-mcp] shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

main().catch((err) => {
  console.error(`[ratel-mcp] ${(err as Error).message}`);
  process.exit(1);
});
