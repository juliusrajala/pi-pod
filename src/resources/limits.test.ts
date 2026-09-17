import { expect, test } from "bun:test";
import { resolvedResourceLimits, resolvedTimeoutMs } from "./limits.ts";

test("rejects resource values that would disable or weaken a limit", () => {
  for (const limits of [
    { memory: "0" },
    { memory: "0g" },
    { memory: "0.1b" },
    { memory: "99999999e" },
    { cpus: 0 },
    { pids: 1.5 },
    { workspaceBytes: 1.5 },
    { temporaryBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() => resolvedResourceLimits(limits)).toThrow();
  }
  expect(resolvedResourceLimits({ cpus: 0.5 }).cpus).toBe(0.5);
});

test("validates library timeouts before lifecycle setup", () => {
  expect(resolvedTimeoutMs("interactive", undefined, 600_000)).toBeUndefined();
  expect(resolvedTimeoutMs("headless", undefined, 600_000)).toBe(600_000);
  expect(() => resolvedTimeoutMs("headless", 0, 600_000)).toThrow("positive integer");
  expect(() => resolvedTimeoutMs("headless", 1.5, 600_000)).toThrow("positive integer");
});
