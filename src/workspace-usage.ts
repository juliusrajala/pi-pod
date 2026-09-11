import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceUsageMonitor = {
  stop: () => void;
  exceeded: () => boolean;
};

/**
 * Bind mounts are outside the container writable layer. This provides a
 * fail-closed aggregate measurement; quota-backed storage remains necessary
 * for a hard disk guarantee.
 */
/** Reject an already-over-budget workspace before its container is started. */
export async function assertWorkspaceWithinLimit(path: string, maxBytes: number, label = "Workspace"): Promise<void> {
  const bytes = await directoryUsageBytes(path);
  if (bytes > maxBytes) throw new Error(`${label} storage limit exceeded before launch (${bytes} bytes > ${maxBytes} bytes).`);
}

export function monitorWorkspaceUsage(input: {
  path: string;
  maxBytes: number;
  intervalMs?: number;
  label?: string;
  controller: AbortController;
  onError?: (message: string) => void;
}): WorkspaceUsageMonitor {
  let stopped = false;
  let checking = false;
  let didExceed = false;

  const check = async () => {
    if (stopped || checking || didExceed) return;
    checking = true;
    try {
      const bytes = await directoryUsageBytes(input.path);
      if (!stopped && bytes > input.maxBytes) {
        didExceed = true;
        input.controller.abort(new Error(`${input.label ?? "Workspace"} storage limit exceeded.`));
      }
    } catch (error) {
      if (!stopped) {
        didExceed = true;
        input.onError?.(`Unable to measure ${input.label ?? "workspace"} usage: ${error instanceof Error ? error.message : String(error)}`);
        input.controller.abort(error);
      }
    } finally {
      checking = false;
    }
  };

  const interval = setInterval(() => void check(), input.intervalMs ?? 1_000);
  void check();
  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    exceeded: () => didExceed,
  };
}

async function directoryUsageBytes(path: string): Promise<number> {
  const root = await lstat(path);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("workspace root is not a real directory");
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    // Do not count or traverse symlinks. Re-lstat closes the normal case where
    // a path changed after readdir; a hostile same-user writer can still race
    // any pathname-based monitor, so this is not represented as a disk quota.
    const metadata = await lstat(entryPath).catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    // A concurrent normal cleanup may remove an entry after readdir. It does
    // not make the remaining tree unmeasurable, so do not fail closed for it.
    if (metadata === undefined || metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      total += await directoryUsageBytes(entryPath);
    } else if (metadata.isFile()) {
      total += metadata.blocks > 0 ? metadata.blocks * 512 : metadata.size;
    }
  }
  return total;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
