import { chmod, lstat, mkdir, open, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const MAX_JSON_BYTES = 1024 * 1024;

export function stateDirectory(): string {
  const xdgState = Bun.env.XDG_STATE_HOME?.trim();
  return join(xdgState || join(Bun.env.HOME?.trim() || homedir(), ".local", "state"), "pi-pod");
}

/**
 * Resolve any existing parent symlinks before state is created. The result may
 * name a missing leaf, which lets workspace validation reject an overlap
 * without first writing wrapper metadata into the candidate workspace.
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return join(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      // realpath cannot resolve a dangling symlink, but mkdir would follow it.
      // Resolve that link explicitly before walking to the next existing parent.
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

/** Acquire pi-pod's canonical, user-owned state root after overlap checks. */
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

/**
 * Create a wrapper-controlled descendant only below the canonical state root.
 * Every existing component is then owned by this user and mode-normalized,
 * rather than trusting a private-looking leaf reached through a symlink.
 */
export async function ensurePrivateStateDirectory(path: string): Promise<string> {
  const root = await privateStateDirectory();
  const canonical = await canonicalPath(path);
  if (!isInside(root, canonical)) throw new Error(`State path escaped the wrapper-owned root: ${path}`);
  await ensurePrivateDirectory(canonical);
  const verified = await realDirectory(canonical, "State directory");
  if (!isInside(root, verified)) throw new Error(`State path escaped the wrapper-owned root: ${path}`);
  const relativePath = relative(root, verified);
  let current = root;
  await ensurePrivateDirectory(current);
  for (const segment of relativePath === "" ? [] : relativePath.split("/")) {
    current = join(current, segment);
    await ensurePrivateDirectory(current);
  }
  return verified;
}

export function validIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} must contain 1-64 letters, numbers, dots, underscores, or dashes.`);
  }
  return value;
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
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

/** Atomically claim a new private file without replacing another creator's data. */
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

export async function readBoundedText(path: string, maxBytes = MAX_JSON_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Maximum file size must be a non-negative safe integer.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Refusing non-regular file: ${path}`);
    if (metadata.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${path}`);
    // Read one extra byte from the verified descriptor. This catches a file
    // that grew after stat without a second pathname lookup or an unbounded
    // read into wrapper memory.
    const buffer = new Uint8Array(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${path}`);
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

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

  // Move the candidate under our private root before its final ownership check.
  // A same-UID replacement with no valid wrapper metadata is restored instead
  // of being recursively deleted through the original run-ID pathname.
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

export function hostToolEnvironment(extra: readonly string[] = []): Record<string, string> {
  const names = new Set([
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "CONTAINERS_CONF",
    "CONTAINERS_STORAGE_CONF",
    "CONTAINERS_REGISTRIES_CONF",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    ...extra,
  ]);
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = Bun.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function commandOutput(command: readonly string[], options: {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
} = {}): Promise<string> {
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0] ?? "Command"} failed (${exitCode}): ${stderr.trim() || "no error output"}`);
  }
  return stdout;
}

export function assertSafeMountPath(path: string): void {
  if (path.includes(",")) {
    throw new Error("Paths containing commas are not supported by Podman's --mount syntax.");
  }
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
