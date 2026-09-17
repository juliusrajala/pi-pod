import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedText, removeOwnedDirectory } from "../utils/fs.ts";

test("bounded reads refuse a symlink instead of following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-utils-"));
  const target = join(root, "target");
  const link = join(root, "link");
  try {
    await writeFile(target, "secret");
    await symlink(target, link);

    await expect(readBoundedText(link)).rejects.toThrow();
    expect(await readBoundedText(target, 6)).toBe("secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores a quarantined run when final ownership verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-utils-remove-"));
  const run = join(root, "run-1");
  const sentinel = join(run, "valuable-work");
  try {
    await mkdir(run);
    await writeFile(sentinel, "retain me");

    await expect(
      removeOwnedDirectory(root, "run-1", async () => {
        throw new Error("ownership changed");
      }),
    ).rejects.toThrow("ownership changed");
    expect(await Bun.file(sentinel).text()).toBe("retain me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
