import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedWorkspace } from "../types.ts";
import { readBoundedText } from "../utils/fs.ts";
import { commandOutput } from "../utils/process.ts";
import { validIdentifier } from "../utils.ts";
import { createRunDirectory, runsDirectory, writeRunMetadata, type RunMetadata, type RunReservation } from "./runs.ts";

const maxAttributeFiles = 1_000;
const maxAttributeBytes = 1024 * 1024;

/** Inspect a local repository and create an independent, clean-HEAD clone. */
export async function prepareClone(input: {
  sourcePath: string;
  runId: string;
  signal?: AbortSignal;
  containerName?: string;
}): Promise<PreparedWorkspace> {
  const { sourcePath, runId, signal, containerName } = input;
  await assertCloneableRepository(sourcePath, signal);
  const root = await runsDirectory();
  const runDirectory = join(root, runId);
  const workspacePath = join(runDirectory, "workspace");
  const metadataPath = join(runDirectory, "run.json");
  const baseRevision = (await git(["rev-parse", "HEAD"], sourcePath, signal)).trim();

  await createRunDirectory(runDirectory, runId);
  try {
    // --no-local prevents hardlinks/shared object stores. --no-checkout keeps
    // source filters dormant until attributes have been rejected above.
    await git([
      "clone", "--no-local", "--no-checkout", "--no-recurse-submodules",
      "--config", "core.hooksPath=/dev/null", "--config", "core.fsmonitor=false",
      sourcePath, workspacePath,
    ], undefined, signal);
    await git(["remote", "remove", "origin"], workspacePath, signal);
    await git(["config", "core.hooksPath", "/dev/null"], workspacePath, signal);
    await git(["config", "core.fsmonitor", "false"], workspacePath, signal);
    await git(["config", "credential.helper", ""], workspacePath, signal);
    await git(["checkout", "--quiet", "--detach", baseRevision], workspacePath, signal);
    await git(["switch", "--quiet", "-c", `pi-pod/${runId}`], workspacePath, signal);
    await assertIndependentClone(workspacePath, signal);
    await writeRunMetadata(runDirectory, {
      version: 1,
      id: runId,
      sourcePath,
      baseRevision,
      createdAt: new Date().toISOString(),
      ...(containerName === undefined ? {} : {
        reservation: {
          containerName: validIdentifier(containerName, "Container name"),
          pid: process.pid,
          startedAt: new Date().toISOString(),
        } satisfies RunReservation,
      }),
    } satisfies RunMetadata);
    return { mode: "clone", path: workspacePath, owned: true, runId, sourcePath, baseRevision };
  } catch (error) {
    // Only this freshly mkdir'd directory is removed on failed preparation.
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

function gitEnvironment(): Record<string, string> {
  const path = Bun.env.PATH;
  if (path === undefined || path.length === 0) throw new Error("PATH is required to inspect a Git workspace.");
  return {
    PATH: path,
    LANG: Bun.env.LANG ?? "C.UTF-8",
    LC_ALL: Bun.env.LC_ALL ?? "C.UTF-8",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function assertCloneableRepository(path: string, signal?: AbortSignal): Promise<void> {
  const repository = (await git(["rev-parse", "--is-inside-work-tree"], path, signal)).trim();
  if (repository !== "true") throw new Error("Clone workspaces must be Git repositories.");
  const gitlinks = await git(["ls-files", "--stage"], path, signal);
  if (gitlinks.split(/\r?\n/).some((line) => line.startsWith("160000 "))) {
    throw new Error("Repositories with submodules are not supported in clone mode yet.");
  }
  await assertNoFilterAttributes(path);
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"], path, signal);
  if (status.trim().length > 0) {
    throw new Error("Clone workspaces require a clean Git repository; use bind mode to include uncommitted or untracked work.");
  }
}

async function assertNoFilterAttributes(root: string): Promise<void> {
  const files = await findAttributeFiles(root);
  const gitInfoAttributes = join(root, ".git", "info", "attributes");
  const infoMetadata = await lstat(gitInfoAttributes).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (infoMetadata !== undefined) files.push(gitInfoAttributes);
  for (const file of files) {
    const content = await readBoundedText(file, maxAttributeBytes);
    if (content.split(/\r?\n/).some(hasFilterAttribute)) {
      throw new Error(`Clone workspaces reject Git filter attributes (${file}) because validating a dirty source must not execute repository-configured commands. Use bind mode instead.`);
    }
  }
}

async function findAttributeFiles(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.name === ".gitattributes") {
        if (entry.isSymbolicLink()) throw new Error(`Clone workspaces reject symlinked Git attributes (${path}).`);
        files.push(path);
        if (files.length > maxAttributeFiles) throw new Error("Clone workspace has too many .gitattributes files to inspect safely.");
        continue;
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) directories.push(path);
    }
  }
  return files;
}

function hasFilterAttribute(line: string): boolean {
  const uncommented = line.trimStart();
  return !uncommented.startsWith("#") && /(?:^|\s)filter=[^\s#]+/u.test(uncommented);
}

async function assertIndependentClone(path: string, signal?: AbortSignal): Promise<void> {
  const alternates = join(path, ".git", "objects", "info", "alternates");
  if (await Bun.file(alternates).exists()) throw new Error("Refusing clone that shares Git object storage with the source repository.");
  const origin = await git(["remote"], path, signal);
  if (origin.trim().length > 0) throw new Error("Refusing clone with a configured remote.");
}

async function git(args: readonly string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  return commandOutput([
    "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", ...args,
  ], { cwd, env: gitEnvironment(), signal });
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
