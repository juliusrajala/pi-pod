import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { managedContainerExists } from "../container/lifecycle.ts";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
  readBoundedText,
  realDirectory,
  removeOwnedDirectory,
  writePrivateFile,
} from "../utils/fs.ts";
import { isInside, validIdentifier } from "../state/identifiers.ts";

export type RunReservation = {
  containerName: string;
  pid: number;
  startedAt: string;
};

export type RunMetadata = {
  version: 1;
  id: string;
  sourcePath?: string;
  baseRevision?: string;
  createdAt?: string;
  reservation?: RunReservation;
};

/** Return the canonical wrapper-owned root for retained clone directories. */
export async function runsDirectory(): Promise<string> {
  const state = await privateStateDirectory();
  const root = join(state, "runs");
  await ensurePrivateStateDirectory(root);
  const canonicalRoot = await realDirectory(root, "Runs directory");
  if (!isInside(state, canonicalRoot)) {
    throw new Error("Runs directory escaped the wrapper-owned state root.");
  }
  return canonicalRoot;
}

/** Exclusively reserve an ID; a pre-existing retained clone is never replaced. */
export async function createRunDirectory(path: string, runId: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isExists(error))
      throw new Error(
        `Run ID "${runId}" already exists; inspect or remove that retained run explicitly.`,
      );
    throw error;
  }
}

export async function writeRunMetadata(path: string, metadata: RunMetadata): Promise<void> {
  await writePrivateFile(join(path, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
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

/** Cleanup a clone only if its exact launch reservation never acquired a container. */
export async function discardUnlaunchedRun(runId: string, containerName: string): Promise<void> {
  const root = await runsDirectory();
  const runDirectory = join(root, validIdentifier(runId, "Run ID"));
  const metadata = await assertRetainedRunMetadata(runDirectory, runId);
  if (metadata.reservation?.containerName !== containerName) {
    throw new Error(`Run "${runId}" is not reserved by container ${containerName}.`);
  }
  if (await managedContainerExists(containerName)) {
    throw new Error(
      `Run "${runId}" has container ${containerName}; refusing unlaunched-run cleanup.`,
    );
  }
  await removeOwnedDirectory(root, runId, async (quarantine) => {
    const moved = await assertRetainedRunMetadata(quarantine, runId);
    if (moved.reservation?.containerName !== containerName) {
      throw new Error(`Run "${runId}" reservation changed during unlaunched-run cleanup.`);
    }
    if (await managedContainerExists(containerName)) {
      throw new Error(
        `Run "${runId}" has container ${containerName}; refusing unlaunched-run cleanup.`,
      );
    }
  });
}

async function assertRetainedRunMetadata(
  runDirectory: string,
  runId: string,
): Promise<RunMetadata> {
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
    throw new Error(
      `Refusing to remove run "${runId}" without valid wrapper metadata: ${errorMessage(error)}`,
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.id !== runId ||
    !validRunReservation(value.reservation)
  ) {
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
    throw new Error(
      `Run "${runId}" is still being prepared by process ${reservation.pid}; refusing to remove its workspace.`,
    );
  }
  if (await managedContainerExists(reservation.containerName)) {
    throw new Error(
      `Run "${runId}" is still mounted by container ${reservation.containerName}; stop it before removing its workspace.`,
    );
  }
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
  )
    return false;
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
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
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
