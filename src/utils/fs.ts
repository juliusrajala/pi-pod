import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isInside, validIdentifier } from "../state/identifiers.ts";

const MAX_JSON_BYTES = 1024 * 1024;

export function stateDirectory(): string {
  const xdgState = Bun.env.XDG_STATE_HOME?.trim();
  return join(xdgState || join(Bun.env.HOME?.trim() || homedir(), ".local", "state"), "pi-pod");
}

/** Resolve existing parent symlinks without creating the missing leaf. */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return join(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const metadata = await lstat(candidate).catch((lstatError) => {
        if (isMissing(lstatError)) return undefined;
        throw lstatError;
      });
      if (metadata?.isSymbolicLink()) {
        candidate = resolve(dirname(candidate), await readlink(candidate));
        continue;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/** Acquire pi-pod's canonical, current-user-owned state root. */
export async function privateStateDirectory(): Promise<string> {
  const configured = resolve(stateDirectory());
  const metadata = await lstat(configured).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink()) throw new Error(`Refusing symlink state path: ${configured}`);
  const canonical = await canonicalPath(configured);
  await ensurePrivateDirectory(canonical);
  return realDirectory(canonical, "State directory");
}

/** Create a private descendant only beneath the canonical wrapper state root. */
export async function ensurePrivateStateDirectory(path: string): Promise<string> {
  const root = await privateStateDirectory();
  const canonical = await canonicalPath(path);
  if (!isInside(root, canonical))
    throw new Error(`State path escaped the wrapper-owned root: ${path}`);
  await ensurePrivateDirectory(canonical);
  const verified = await realDirectory(canonical, "State directory");
  if (!isInside(root, verified))
    throw new Error(`State path escaped the wrapper-owned root: ${path}`);
  const relativePath = relative(root, verified);
  let current = root;
  await ensurePrivateDirectory(current);
  for (const segment of relativePath === "" ? [] : relativePath.split("/")) {
    current = join(current, segment);
    await ensurePrivateDirectory(current);
  }
  return verified;
}

export async function realDirectory(path: string, label = "Path"): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(resolve(path));
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return resolved;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing non-directory or symlink state path: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Refusing state directory not owned by the current user: ${path}`);
  }
  await chmod(path, 0o700);
}

export async function writePrivateFile(path: string, value: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeNewPrivateFile(path: string, value: string): Promise<boolean> {
  await ensurePrivateDirectory(dirname(path));
  try {
    await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
    return true;
  } catch (error) {
    if (isExists(error)) return false;
    throw error;
  }
}

/** Read a bounded regular file through a no-follow descriptor. */
export async function readBoundedText(path: string, maxBytes = MAX_JSON_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Maximum file size must be a non-negative safe integer.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Refusing non-regular file: ${path}`);
    if (metadata.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${path}`);
    const buffer = new Uint8Array(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${path}`);
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Quarantine a verified state child before recursively deleting it. */
export async function removeOwnedDirectory(
  root: string,
  id: string,
  verify?: (directory: string) => Promise<void>,
): Promise<void> {
  validIdentifier(id, "Run ID");
  const canonicalRoot = await realDirectory(root, "State directory");
  const candidate = join(canonicalRoot, id);
  const metadata = await lstat(candidate).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isInside(canonicalRoot, candidate)) {
    throw new Error("Refusing to remove a path outside the wrapper-owned state directory.");
  }
  const quarantine = join(canonicalRoot, `.removing-${id}-${crypto.randomUUID()}`);
  await rename(candidate, quarantine);
  let deletionStarted = false;
  try {
    const moved = await lstat(quarantine);
    if (!moved.isDirectory() || moved.isSymbolicLink()) {
      throw new Error("Refusing to remove a path that changed while being quarantined.");
    }
    await verify?.(quarantine);
    deletionStarted = true;
    await rm(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (!deletionStarted) await rename(quarantine, candidate).catch(() => undefined);
    throw error;
  }
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
