import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { managedContainerExists } from "./container/lifecycle.ts";
import { join } from "node:path";
import type { PreparedWorkspace, WorkspaceMode } from "./types.ts";
import { canonicalPath, commandOutput, ensurePrivateStateDirectory, isInside, privateStateDirectory, readBoundedText, realDirectory, removeOwnedDirectory, stateDirectory, validIdentifier, writePrivateFile } from "./utils.ts";

const maxAttributeFiles = 1_000;
const maxAttributeBytes = 1024 * 1024;

/**
 * Source inspection happens on the host. Keep this environment deliberately
 * small: inherited GIT_CONFIG_* variables can inject configuration before the
 * command-line overrides below are considered.
 */
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

export async function prepareWorkspace(input: {
  path: string;
  mode: WorkspaceMode;
  runId?: string;
  /** Internal lifecycle reservation; omitted by standalone workspace callers. */
  containerName?: string;
  signal?: AbortSignal;
}): Promise<PreparedWorkspace> {
  const sourcePath = await realDirectory(input.path, "Workspace");
  await assertWorkspaceDoesNotOverlapState(sourcePath);
  if (input.mode === "bind") {
    await assertBindableWorkspace(sourcePath);
    return { mode: "bind", path: sourcePath, owned: false, sourcePath };
  }
  const runId = validIdentifier(input.runId ?? crypto.randomUUID(), "Run ID");
  return prepareClone(sourcePath, runId, input.signal, input.containerName);
}

/** Remove a retained clone only after its wrapper reservation is inactive. */
export async function removeRun(runId: string): Promise<void> {
  validIdentifier(runId, "Run ID");
  const root = await runsDirectory();
  const runDirectory = join(root, runId);
  const metadata = await assertRetainedRunMetadata(runDirectory, runId);
  await assertRunReservationInactive(metadata, runId);
  await removeOwnedDirectory(root, runId, async (quarantine) => {
    const moved = await assertRetainedRunMetadata(quarantine, runId);
    await assertRunReservationInactive(moved, runId);
  });
}

/** Mark a clone as retained once its associated container is verified absent. */
export async function releaseRunReservation(runId: string, containerName: string): Promise<void> {
  const root = await runsDirectory();
  const runDirectory = join(root, validIdentifier(runId, "Run ID"));
  const metadata = await assertRetainedRunMetadata(runDirectory, runId);
  if (metadata.reservation?.containerName !== containerName) {
    throw new Error(`Run "${runId}" is not reserved by container ${containerName}.`);
  }
  const { reservation: _reservation, ...retained } = metadata;
  await writePrivateFile(join(runDirectory, "run.json"), `${JSON.stringify(retained, null, 2)}\n`);
}

/** Cleanup path for a clone whose Podman client could not be started. */
export async function discardUnlaunchedRun(runId: string, containerName: string): Promise<void> {
  const root = await runsDirectory();
  const runDirectory = join(root, validIdentifier(runId, "Run ID"));
  const metadata = await assertRetainedRunMetadata(runDirectory, runId);
  if (metadata.reservation?.containerName !== containerName) {
    throw new Error(`Run "${runId}" is not reserved by container ${containerName}.`);
  }
  if (await managedContainerExists(containerName)) {
    throw new Error(`Run "${runId}" has container ${containerName}; refusing unlaunched-run cleanup.`);
  }
  await removeOwnedDirectory(root, runId, async (quarantine) => {
    const moved = await assertRetainedRunMetadata(quarantine, runId);
    if (moved.reservation?.containerName !== containerName) {
      throw new Error(`Run "${runId}" reservation changed during unlaunched-run cleanup.`);
    }
    if (await managedContainerExists(containerName)) {
      throw new Error(`Run "${runId}" has container ${containerName}; refusing unlaunched-run cleanup.`);
    }
  });
}

async function runsDirectory(): Promise<string> {
  const state = await privateStateDirectory();
  const root = join(state, "runs");
  await ensurePrivateStateDirectory(root);
  const canonicalRoot = await realDirectory(root, "Runs directory");
  if (!isInside(state, canonicalRoot)) {
    throw new Error("Runs directory escaped the wrapper-owned state root.");
  }
  return canonicalRoot;
}

async function assertWorkspaceDoesNotOverlapState(workspace: string): Promise<void> {
  const canonicalState = await canonicalStatePath();
  if (isInside(workspace, canonicalState) || isInside(canonicalState, workspace)) {
    throw new Error("Workspace overlaps pi-pod state. Choose an XDG_STATE_HOME outside the mounted workspace.");
  }
}

async function canonicalStatePath(): Promise<string> {
  // Do not call privateStateDirectory here: a rejected workspace must not
  // receive a newly-created state directory as a side effect of validation.
  return canonicalPath(stateDirectory());
}

type RunReservation = {
  containerName: string;
  pid: number;
  startedAt: string;
};

type RunMetadata = {
  version: 1;
  id: string;
  sourcePath?: string;
  baseRevision?: string;
  createdAt?: string;
  reservation?: RunReservation;
};

async function assertRetainedRunMetadata(runDirectory: string, runId: string): Promise<RunMetadata> {
  const directory = await lstat(runDirectory).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (directory === undefined || !directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Refusing to remove run "${runId}" without a real wrapper-owned directory.`);
  }
  const metadataPath = join(runDirectory, "run.json");
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedText(metadataPath));
  } catch (error) {
    throw new Error(`Refusing to remove run "${runId}" without valid wrapper metadata: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.version !== 1 || value.id !== runId || !validRunReservation(value.reservation)) {
    throw new Error(`Refusing to remove run "${runId}" without matching wrapper metadata.`);
  }
  return {
    version: 1,
    id: runId,
    ...(typeof value.sourcePath === "string" ? { sourcePath: value.sourcePath } : {}),
    ...(typeof value.baseRevision === "string" ? { baseRevision: value.baseRevision } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(value.reservation === undefined ? {} : { reservation: value.reservation }),
  };
}

async function assertRunReservationInactive(metadata: RunMetadata, runId: string): Promise<void> {
  const reservation = metadata.reservation;
  if (reservation === undefined) return;
  if (processExists(reservation.pid)) {
    throw new Error(`Run "${runId}" is still being prepared by process ${reservation.pid}; refusing to remove its workspace.`);
  }
  if (await managedContainerExists(reservation.containerName)) {
    throw new Error(`Run "${runId}" is still mounted by container ${reservation.containerName}; stop it before removing its workspace.`);
  }
}

async function assertBindableWorkspace(path: string): Promise<void> {
  const dotGit = join(path, ".git");
  const metadata = await lstat(dotGit).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  if (metadata.isSymbolicLink() || metadata.isFile()) {
    throw new Error("Bind workspaces cannot use external Git metadata (linked worktrees are unsupported). Mount a regular checkout or use clone mode.");
  }
  if (!metadata.isDirectory()) throw new Error("Workspace .git must be a directory when present.");
}

async function prepareClone(sourcePath: string, runId: string, signal?: AbortSignal, containerName?: string): Promise<PreparedWorkspace> {
  await assertCloneableRepository(sourcePath, signal);
  const root = await runsDirectory();
  const runDirectory = join(root, runId);
  const workspacePath = join(runDirectory, "workspace");
  const metadataPath = join(runDirectory, "run.json");
  const baseRevision = (await git(["rev-parse", "HEAD"], sourcePath, signal)).trim();

  await createRunDirectory(runDirectory, runId);
  try {
    // --no-local prevents hardlinks and shared object stores when cloning a
    // local repository. --no-checkout avoids host-side filter execution until
    // the repository is known not to declare one.
    await git([
      "clone",
      "--no-local",
      "--no-checkout",
      "--no-recurse-submodules",
      "--config",
      "core.hooksPath=/dev/null",
      "--config",
      "core.fsmonitor=false",
      sourcePath,
      workspacePath,
    ], undefined, signal);
    await git(["remote", "remove", "origin"], workspacePath, signal);
    await git(["config", "core.hooksPath", "/dev/null"], workspacePath, signal);
    await git(["config", "core.fsmonitor", "false"], workspacePath, signal);
    await git(["config", "credential.helper", ""], workspacePath, signal);
    await git(["checkout", "--quiet", "--detach", baseRevision], workspacePath, signal);
    await git(["switch", "--quiet", "-c", `pi-pod/${runId}`], workspacePath, signal);
    await assertIndependentClone(workspacePath, signal);
    await writePrivateFile(metadataPath, `${JSON.stringify({
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
    } satisfies RunMetadata, null, 2)}\n`);
    return {
      mode: "clone",
      path: workspacePath,
      owned: true,
      runId,
      sourcePath,
      baseRevision,
    };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function createRunDirectory(path: string, runId: string): Promise<void> {
  try {
    // The directory is our exclusive ownership proof. Never replace a prior
    // retained clone merely because a caller repeated an ID.
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isExists(error)) throw new Error(`Run ID "${runId}" already exists; inspect or remove that retained run explicitly.`);
    throw error;
  }
}

async function assertCloneableRepository(path: string, signal?: AbortSignal): Promise<void> {
  const repository = (await git(["rev-parse", "--is-inside-work-tree"], path, signal)).trim();
  if (repository !== "true") throw new Error("Clone workspaces must be Git repositories.");

  const gitlinks = await git(["ls-files", "--stage"], path, signal);
  if (gitlinks.split(/\r?\n/).some((line) => line.startsWith("160000 "))) {
    throw new Error("Repositories with submodules are not supported in clone mode yet.");
  }

  // `git status` may invoke a repository-configured clean filter for a dirty
  // file. Inspect every working-tree attribute file first, without asking Git
  // to refresh the index, so a clone request cannot execute source commands.
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
        if (entry.isSymbolicLink()) {
          throw new Error(`Clone workspaces reject symlinked Git attributes (${path}).`);
        }
        files.push(path);
        if (files.length > maxAttributeFiles) {
          throw new Error("Clone workspace has too many .gitattributes files to inspect safely.");
        }
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) directories.push(path);
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
  const exists = await Bun.file(alternates).exists();
  if (exists) throw new Error("Refusing clone that shares Git object storage with the source repository.");
  const origin = await git(["remote"], path, signal);
  if (origin.trim().length > 0) throw new Error("Refusing clone with a configured remote.");
}

async function git(args: readonly string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  return commandOutput([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "credential.helper=",
    ...args,
  ], { cwd, env: gitEnvironment(), signal });
}

function validRunReservation(value: unknown): value is RunReservation | undefined {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    typeof value.containerName !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== "string"
  ) {
    return false;
  }
  try {
    validIdentifier(value.containerName, "Container name");
    return true;
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
