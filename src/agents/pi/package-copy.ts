import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePiPackages, type PiDevPackage } from "../../config/pi-packages.ts";

// Bound total staging work, including directories and overlapping selections.
const maxBytes = 32 * 1024 * 1024;
const maxEntries = 4096;

/** Copy selected package files, never mount the source or follow child symlinks. */
export async function copyPiPackages(
  packages: PiDevPackage[],
  directory: string,
): Promise<string[]> {
  const selections = parsePiPackages(packages);
  const budget = { bytes: 0, entries: 0 };
  const copies: string[] = [];
  for (const [index, selection] of selections.entries()) {
    const source = await realpath(selection.source);
    if (!(await lstat(source)).isDirectory())
      throw new Error("Pi package source must be a directory.");
    const destination = join(directory, `package-${index}`);
    for (const path of selection.files) {
      // Check intermediate components as well as the selected leaf.
      let current = source;
      for (const part of path.split("/")) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Pi package copies do not follow symlinks: ${current}`);
        }
      }
      await copyEntry(join(source, path), join(destination, path), budget, 0);
    }
    copies.push(destination);
  }
  return copies;
}

async function copyEntry(
  source: string,
  destination: string,
  budget: { bytes: number; entries: number },
  depth: number,
): Promise<void> {
  if (++budget.entries > maxEntries || depth > 32)
    throw new Error("Pi package copy exceeds entry/depth limits.");
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink())
    throw new Error(`Pi package copies do not follow symlinks: ${source}`);
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      await copyEntry(join(source, entry), join(destination, entry), budget, depth + 1);
    }
    return;
  }
  if (!metadata.isFile()) throw new Error(`Pi package copy requires regular files: ${source}`);
  const handle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await handle.stat();
    if (!actual.isFile()) throw new Error(`Pi package copy requires regular files: ${source}`);
    if (actual.size > maxBytes - budget.bytes) throw new Error("Pi package copies exceed 32 MiB.");
    const chunks: Buffer[] = [];
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - budget.bytes + 1));
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) break;
      budget.bytes += bytesRead;
      if (budget.bytes > maxBytes) throw new Error("Pi package copies exceed 32 MiB.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.concat(chunks), {
      mode: actual.mode & 0o100 ? 0o700 : 0o600,
    });
  } finally {
    await handle.close();
  }
}
