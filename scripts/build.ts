import { lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import { buildRelease } from "./build-release.ts";

type BuildSteps = {
  compile: (bundle: string) => Promise<void>;
  verify: (bundle: string) => Promise<void>;
  image: (bundle: string) => Promise<void>;
};

/** Publish only complete builds; preserve the previous bundle on any build failure. */
export async function buildLocal(
  root: string,
  version: string,
  steps: BuildSteps,
): Promise<string> {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  const lock = join(dist, ".build-lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Another build is running. If it was interrupted, remove dist/.build-lock and retry.",
      );
    }
    throw error;
  }
  let staging: string | undefined;
  try {
    const latest = join(dist, "latest");
    const latestStat = await statIfPresent(latest);
    if (latestStat && !latestStat.isSymbolicLink()) {
      throw new Error("dist/latest must be a symlink; refusing to replace it.");
    }
    const name = `pi-pod-${version}-linux-x64`;
    const output = join(dist, name);
    const existing = await statIfPresent(output);
    if (existing && !existing.isDirectory()) {
      throw new Error(`Refusing to replace non-directory bundle: ${output}`);
    }
    staging = await mkdtemp(join(dist, ".build-"));
    const bundle = join(staging, name);
    console.log("[1/3] Compiling CLI");
    await steps.compile(bundle);
    console.log("[2/3] Verifying bundle");
    await steps.verify(bundle);
    console.log("[3/3] Building matching agent image");
    await steps.image(bundle);

    // Keep older same-version builds for rollback instead of deleting them.
    const backup = `${output}.previous-${crypto.randomUUID()}`;
    if (existing) await rename(output, backup);
    try {
      await rename(bundle, output);
    } catch (error) {
      if (existing) await rename(backup, output);
      throw error;
    }
    const next = join(staging, "latest");
    await symlink(name, next);
    await rename(next, latest);
    return output;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Build step failed: ${argv[0]}`);
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun run build");
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Local builds require native Linux x64 with rootless Podman.");
  }
  const root = join(import.meta.dir, "..");
  const output = await buildLocal(root, packageManifest.version, {
    compile: (bundle) => buildRelease(["--target", "linux-x64"], bundle),
    verify: (bundle) => run([process.execPath, join(import.meta.dir, "verify-release.ts"), bundle]),
    image: (bundle) => run([join(bundle, "pi-pod"), "build"]),
  });
  console.log(`Ready: ${output}\nRun ./pi-pod dev /path/to/project`);
}
