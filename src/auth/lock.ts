import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { managedContainerExists } from "../container/lifecycle.ts";
import { writePrivateFile } from "../utils/fs.ts";
import { validIdentifier } from "../state/identifiers.ts";
import { profileVersion, readAuthMetadata, type AuthProfile } from "./profiles.ts";

type LockOwner = {
  version: typeof profileVersion;
  pid: number;
  startedAt: string;
  containerName: string | null;
};

export type ProfileLock = {
  release: () => Promise<void>;
};

/** Serialize access to a profile which can be refreshed by only one agent. */
export async function acquireAuthProfile(
  profile: AuthProfile,
  options: { containerName?: string } = {},
): Promise<ProfileLock> {
  const lockPath = join(profile.directory, ".active");
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isExists(error)) {
      throw new Error(
        `Auth profile "${profile.name}" is already in use. Parallel runs cannot share a refreshing credential profile.`,
      );
    }
    throw error;
  }
  const containerName =
    options.containerName === undefined
      ? null
      : validIdentifier(options.containerName, "Container name");
  await writePrivateFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({
      version: profileVersion,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      containerName,
    } satisfies LockOwner)}\n`,
  );
  return {
    release: async () => {
      await rm(lockPath, { recursive: true, force: true });
    },
  };
}

/** Remove only a stale lock whose process and managed container are both gone. */
export async function removeAuthProfileLock(profile: AuthProfile): Promise<void> {
  const lockPath = join(profile.directory, ".active");
  const owner = await readLockOwner(join(lockPath, "owner.json"));
  if (owner === undefined) {
    throw new Error(
      `Auth profile "${profile.name}" has invalid lock metadata; refusing to unlock it automatically.`,
    );
  }
  if (processExists(owner.pid)) {
    throw new Error(
      `Auth profile "${profile.name}" may still be used by process ${owner.pid}; refusing to unlock it.`,
    );
  }
  if (owner.containerName !== null && (await managedContainerExists(owner.containerName))) {
    throw new Error(
      `Auth profile "${profile.name}" is still mounted by container ${owner.containerName}; stop it before unlocking.`,
    );
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value = await readAuthMetadata(path, "auth lock metadata");
    if (
      !isRecord(value) ||
      value.version !== profileVersion ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== "string" ||
      (value.containerName !== null && typeof value.containerName !== "string")
    ) {
      return undefined;
    }
    if (typeof value.containerName === "string")
      validIdentifier(value.containerName, "Container name");
    return {
      version: profileVersion,
      pid: value.pid,
      startedAt: value.startedAt,
      containerName: value.containerName,
    };
  } catch {
    return undefined;
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

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
