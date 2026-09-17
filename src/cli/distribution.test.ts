import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditedContainerfileSha256, releaseBuildRecipe } from "./distribution.ts";

const sourceContainerfile = join(import.meta.dir, "..", "..", "container", "Containerfile");

test("release recipe resolution is adjacent to the canonical executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-release-layout-"));
  try {
    const executable = join(root, "pi-pod");
    const recipe = join(root, "container", "Containerfile");
    await mkdir(join(root, "container"));
    await writeFile(executable, "compiled fixture");
    await chmod(executable, 0o755);
    await writeFile(recipe, await readFile(sourceContainerfile));

    const layout = await releaseBuildRecipe(executable);
    expect(layout.context).toBe(join(root, "container"));
    expect(layout.containerfile).toBe(recipe);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release recipe resolution rejects a symlink or altered recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-release-recipe-"));
  try {
    const executable = join(root, "pi-pod");
    const context = join(root, "container");
    await mkdir(context);
    await writeFile(executable, "compiled fixture");
    await symlink(sourceContainerfile, join(context, "Containerfile"));
    await expect(releaseBuildRecipe(executable)).rejects.toThrow("regular non-symlink");
    await rm(join(context, "Containerfile"));
    await writeFile(join(context, "Containerfile"), "altered");
    await expect(releaseBuildRecipe(executable)).rejects.toThrow(auditedContainerfileSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
