import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocal } from "./build.ts";

test("repeated same-version builds publish new source only after the image succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-build-"));
  try {
    let source = "first";
    const steps = {
      compile: async (bundle: string) => {
        await mkdir(bundle);
        await writeFile(join(bundle, "pi-pod"), source);
      },
      verify: async () => {},
      image: async () => {},
    };
    const output = await buildLocal(root, "0.2.0", steps);
    expect(await readlink(join(root, "dist/latest"))).toBe("pi-pod-0.2.0-linux-x64");
    source = "second";
    await buildLocal(root, "0.2.0", {
      ...steps,
      image: async () => {
        expect(await readFile(join(output, "pi-pod"), "utf8")).toBe("first");
      },
    });
    expect(await readFile(join(output, "pi-pod"), "utf8")).toBe("second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed verification or image build preserves the last ready bundle and permits retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-build-failure-"));
  try {
    const output = join(root, "dist/pi-pod-0.2.0-linux-x64");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "pi-pod"), "old");
    await symlink("pi-pod-0.2.0-linux-x64", join(root, "dist/latest"));
    for (const phase of ["compile", "verify", "image"] as const) {
      await expect(
        buildLocal(root, "0.2.0", {
          compile: async (bundle) => {
            await mkdir(bundle);
          },
          verify: async () => {},
          image: async () => {},
          [phase]: async () => {
            throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");
      expect(await readFile(join(output, "pi-pod"), "utf8")).toBe("old");
      expect(await readlink(join(root, "dist/latest"))).toBe("pi-pod-0.2.0-linux-x64");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
