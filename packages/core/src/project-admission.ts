import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export interface ProjectAdmissionLock {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ProjectAdmissionLockOptions {
  controlDir: string;
}

const LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: { retries: 300, factor: 1, minTimeout: 10, maxTimeout: 100 },
} as const;

/**
 * Serializes project registration/initialize and forget admission. The lock file
 * is shared by daemon HTTP and offline CLI processes.
 */
export function createProjectAdmissionLock(
  options: ProjectAdmissionLockOptions,
): ProjectAdmissionLock {
  const lockPath = join(options.controlDir, "project-admission.lock");
  return {
    async run(operation) {
      await mkdir(options.controlDir, { recursive: true });
      const release = await lockfile.lock(options.controlDir, {
        ...LOCK_OPTIONS,
        lockfilePath: lockPath,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    },
  };
}
