import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWorkspaceWithinLimit } from "./workspace-usage.ts";

test("rejects a workspace already over its storage budget before launch", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "pi-pod-usage-XXXXXX")}`.text();
  const workspace = root.trim();
  try {
    await mkdir(join(workspace, "nested"));
    await writeFile(join(workspace, "nested", "large-file"), "x".repeat(8_192));

    await expect(assertWorkspaceWithinLimit(workspace, 1)).rejects.toThrow("exceeded before launch");
    await expect(assertWorkspaceWithinLimit(workspace, 16 * 1024)).resolves.toBeUndefined();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
