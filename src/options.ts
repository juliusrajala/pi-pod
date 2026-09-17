import { defaultResourceLimits } from "./defaults.ts";
import type { ResourceLimits, RunMode } from "./types.ts";

const memoryPattern = /^(\d+(?:\.\d+)?)([bkmgte]?)$/iu;
const memoryMultipliers: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  e: 1024 ** 5,
};

/** Resolve resource limits once, before any filesystem or Podman operation. */
export function resolvedResourceLimits(overrides: Partial<ResourceLimits> | undefined): ResourceLimits {
  const limits = { ...defaultResourceLimits, ...overrides };
  const memory = typeof limits.memory === "string" ? memoryPattern.exec(limits.memory) : null;
  if (memory === null) throw new Error("Memory limit must be a positive representable Podman size such as 4g.");
  const memoryBytes = Number(memory[1]) * memoryMultipliers[memory[2]?.toLowerCase() ?? ""]!;
  if (!Number.isFinite(memoryBytes) || memoryBytes < 1 || memoryBytes > Number.MAX_SAFE_INTEGER) {
    throw new Error("Memory limit must be a positive representable Podman size such as 4g.");
  }
  if (!Number.isFinite(limits.cpus) || limits.cpus <= 0) {
    throw new Error("cpus must be a positive number.");
  }
  for (const [name, value] of Object.entries({
    pids: limits.pids,
    workspaceBytes: limits.workspaceBytes,
    temporaryBytes: limits.temporaryBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  return limits;
}

/** Interactive runs are unbounded by default; headless runs have a fixed ceiling. */
export function resolvedTimeoutMs(mode: RunMode, value: number | undefined, headlessDefault: number): number | undefined {
  const timeoutMs = value ?? (mode === "headless" ? headlessDefault : undefined);
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer number of milliseconds.");
  }
  return timeoutMs;
}
