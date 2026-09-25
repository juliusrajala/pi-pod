import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Digest of the audited recipe shipped with the current host controller. */
export const auditedContainerfileSha256 =
  "ca88bef59ae1f0f33feffb0ca2aab7df9615c7e2f69bbb1f7e0d8712b4e99efc";
export const auditedAgentPackageJsonSha256 =
  "85a2d2015baea0f826ad7bc9df453ca5189fe70d6078842504891e20deecae40";
export const auditedAgentLockSha256 =
  "d8b3367c1999892e691d5a26d01f73174b45fc99631049cad8f87db5b3b2339b";

export type BuildRecipeLayout = {
  context: string;
  containerfile: string;
};

/**
 * Resolve the recipe next to a compiled executable. This deliberately does
 * not search cwd, PATH, or a user-selected location.
 */
export async function releaseBuildRecipe(
  executablePath = process.execPath,
): Promise<BuildRecipeLayout> {
  let executable: string;
  try {
    executable = await realpath(executablePath);
  } catch {
    throw new Error(`Could not resolve the compiled pi-pod executable: ${executablePath}`);
  }

  const bundle = dirname(executable);
  const context = join(bundle, "container");
  const containerfile = join(context, "Containerfile");
  await requireDirectory(context, "release container context");
  await requireRegularFile(containerfile, "release Containerfile");

  const digest = createHash("sha256")
    .update(await readFile(containerfile))
    .digest("hex");
  if (digest !== auditedContainerfileSha256) {
    throw new Error(
      `The release Containerfile has been altered; expected SHA-256 ${auditedContainerfileSha256}, found ${digest}. Reinstall the complete pi-pod release bundle.`,
    );
  }
  await requireAuditedFile(join(context, "package.json"), auditedAgentPackageJsonSha256);
  await requireAuditedFile(join(context, "bun.lock"), auditedAgentLockSha256);
  return { context, containerfile };
}

async function requireDirectory(path: string, description: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error(`${description} is not a directory: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes(" is not a directory:")) throw error;
    throw new Error(`Missing ${description}: ${path}`);
  }
}

async function requireAuditedFile(path: string, expected: string): Promise<void> {
  await requireRegularFile(path, `release dependency file`);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (digest !== expected) {
    throw new Error(`The release dependency file has been altered: ${path}`);
  }
}

async function requireRegularFile(path: string, description: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error(`${description} must be a regular non-symlink file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a regular")) throw error;
    throw new Error(`Missing ${description}: ${path}`);
  }
}
