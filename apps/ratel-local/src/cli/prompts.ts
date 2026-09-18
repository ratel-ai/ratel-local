import * as clack from "@clack/prompts";
import { detectOutputEnvironment, type OutputEnvironment } from "./output/environment.js";
import { type CliOutput, createCliOutput } from "./output/index.js";

export const CANCEL_SYMBOL = Symbol("ratel.prompt.cancel");

export interface SpinnerHandle {
  start(message?: string): void;
  stop(message?: string): void;
  message(message: string): void;
}

export interface PromptAdapter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  select<T>(opts: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initialValue?: T;
  }): Promise<T | symbol>;
  multiselect<T>(opts: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    required?: boolean;
    initialValues?: T[];
  }): Promise<T[] | symbol>;
  text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
  }): Promise<string | symbol>;
  password(opts: { message: string; mask?: string }): Promise<string | symbol>;
  spinner(): SpinnerHandle;
  isCancel(value: unknown): boolean;
  cancel(message?: string): void;
  /** False when stdin is not a terminal: a pipe, a file, or most CI runners. */
  canPrompt(): boolean;
}

export class PromptUnavailableError extends Error {
  constructor(message: string) {
    super(
      `Interactive input required: ${message} Run in a terminal or supply explicit command options.`,
    );
    this.name = "PromptUnavailableError";
  }
}

export function defaultPromptAdapter(
  options: { environment?: OutputEnvironment; output?: CliOutput } = {},
): PromptAdapter {
  const environment = options.environment ?? detectOutputEnvironment();
  const output = options.output ?? createCliOutput({ environment });
  const common = { input: process.stdin, output: process.stderr };
  const requireTerminal = (message: string) => {
    if (!environment.interactive) throw new PromptUnavailableError(message);
  };
  return {
    intro: output.heading,
    outro: output.success,
    note(message, title) {
      if (title) output.heading(title);
      output.text(message);
    },
    async confirm(opts) {
      requireTerminal(opts.message);
      return clack.confirm({ ...opts, ...common });
    },
    async select(opts) {
      requireTerminal(opts.message);
      return (clack.select as PromptAdapter["select"])({ ...opts, ...common });
    },
    async multiselect(opts) {
      requireTerminal(opts.message);
      return (clack.multiselect as PromptAdapter["multiselect"])({ ...opts, ...common });
    },
    async text(opts) {
      requireTerminal(opts.message);
      return clack.text({ ...opts, ...common });
    },
    async password(opts) {
      requireTerminal(opts.message);
      return clack.password({ ...opts, ...common });
    },
    spinner: output.spinner,
    isCancel: clack.isCancel,
    cancel: (message = "Cancelled") => output.warning(message),
    canPrompt: () => environment.interactive,
  };
}

export function silentPromptAdapter(): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note() {},
    async confirm() {
      return true;
    },
    async select() {
      return CANCEL_SYMBOL;
    },
    async multiselect() {
      return CANCEL_SYMBOL;
    },
    async text() {
      return "";
    },
    async password() {
      return "";
    },
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    isCancel(value) {
      return value === CANCEL_SYMBOL;
    },
    cancel() {},
    canPrompt: () => false,
  };
}
