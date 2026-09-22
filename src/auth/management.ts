import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateStateDirectory, privateStateDirectory } from "../utils/fs.ts";

/** Serialize short profile/default management mutations; run staging is never locked. */
export async function withAuthManagement<T>(operation: () => Promise<T>): Promise<T> {
  const root = await ensurePrivateStateDirectory(
    join(await privateStateDirectory(), "auth-management"),
  );
  const lock = join(root, "active");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (isExists(error)) {
      throw new Error("Authentication profile management is already in progress; retry shortly.");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
