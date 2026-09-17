import type { ResourceLimits } from "../execution/types.ts";

/** Shared, pinned image reference. Builds and launches never discover an image. */
export const defaultImage = "localhost/pi-pod:0.1.0";

/** Headless runs have an explicit ten-minute default; interactive runs do not. */
export const defaultHeadlessTimeoutMs = 10 * 60 * 1_000;

export const defaultResourceLimits: ResourceLimits = {
  memory: "4g",
  cpus: 4,
  pids: 512,
  workspaceBytes: 4 * 1024 * 1024 * 1024,
  temporaryBytes: 512 * 1024 * 1024,
};
