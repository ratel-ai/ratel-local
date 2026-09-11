import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import * as clack from "@clack/prompts";
import type { SpinnerHandle } from "../prompts.js";
import { detectOutputEnvironment, type OutputEnvironment } from "./environment.js";
import { createProgress } from "./progress.js";
import { renderMessage, renderTable, style } from "./render.js";

export interface CliOutput {
  text(message: string): void;
  success(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  heading(title: string): void;
  list(items: string[]): void;
  table(columns: string[], rows: string[][]): void;
  spinner(): SpinnerHandle;
  progress(message: string): SpinnerHandle;
}

export interface CliOutputOptions {
  environment?: OutputEnvironment;
  /** Receives a complete line, without its final newline. */
  write?: (message: string) => void;
  stream?: Writable;
}

export function createCliOutput(options: CliOutputOptions = {}): CliOutput {
  const environment = options.environment ?? detectOutputEnvironment();
  const stream = options.stream ?? process.stderr;
  const write =
    options.write ??
    ((message: string) => {
      stream.write(`${message}\n`);
    });
  const spinner = () =>
    createProgress({
      interactive: environment.interactive,
      write,
      spinner: () => clack.spinner({ output: stream, indicator: "dots" }),
    });
  return {
    text: (message) => write(stripVTControlCharacters(message)),
    success: (message) => write(renderMessage("ok", message, environment.color)),
    info: (message) => write(renderMessage("info", message, environment.color)),
    warning: (message) => write(renderMessage("warning", message, environment.color)),
    error: (message) => write(renderMessage("error", message, environment.color)),
    heading: (title) => write(style(title, 1, environment.color)),
    list: (items) => {
      for (const item of items) write(`- ${stripVTControlCharacters(item)}`);
    },
    table: (columns, rows) => {
      for (const line of renderTable(columns, rows, environment)) write(line);
    },
    spinner,
    progress(message) {
      const handle = spinner();
      handle.start(message);
      return handle;
    },
  };
}

/** Direct handler callers can keep injecting a logger without depending on a terminal. */
export function getCliOutput(ctx: {
  output?: CliOutput;
  log: (message: string) => void;
}): CliOutput {
  return (
    ctx.output ??
    createCliOutput({
      write: ctx.log,
      environment: { interactive: false, color: false, width: 80 },
    })
  );
}
