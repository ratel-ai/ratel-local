import { stripVTControlCharacters } from "node:util";
import type { SpinnerHandle } from "../prompts.js";

export function createProgress(options: {
  interactive: boolean;
  write: (message: string) => void;
  spinner: () => SpinnerHandle;
}): SpinnerHandle {
  let active = false;
  let handle: SpinnerHandle | undefined;
  let lastMessage = "";
  return {
    start(message = "Working…") {
      if (active) return;
      active = true;
      lastMessage = stripVTControlCharacters(message);
      if (options.interactive) {
        handle = options.spinner();
        handle.start(lastMessage);
      } else options.write(lastMessage);
    },
    message(message) {
      if (!active) return;
      lastMessage = stripVTControlCharacters(message);
      handle?.message(lastMessage);
    },
    stop(message) {
      if (!active) return;
      active = false;
      const result = stripVTControlCharacters(message ?? lastMessage);
      if (handle) handle.stop(result);
      else options.write(result);
    },
  };
}
