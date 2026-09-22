import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "./fs.ts";

test("canonicalPath preserves the order of multiple missing descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-canonical-"));
  try {
    const path = join(root, "state", "pi-pod", "staging");
    expect(await canonicalPath(path)).toBe(path);
    await symlink(root, join(root, "alias"));
    expect(await canonicalPath(join(root, "alias", "state", "pi-pod"))).toBe(
      join(root, "state", "pi-pod"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
