import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  auditedAgentLockSha256,
  auditedAgentPackageJsonSha256,
  auditedContainerfileSha256,
} from "../src/cli/distribution.ts";

const [requested] = process.argv.slice(2);
if (requested === undefined || process.argv.slice(2).length !== 1) {
  throw new Error("Usage: bun run verify:release -- dist/pi-pod-linux-x64");
}
const bundle = await realpath(
  isAbsolute(requested) ? requested : resolve(process.cwd(), requested),
);
const expected = new Map([
  ["pi-pod", ""],
  ["container/Containerfile", auditedContainerfileSha256],
  ["container/package.json", auditedAgentPackageJsonSha256],
  ["container/bun.lock", auditedAgentLockSha256],
  ["README.md", ""],
]);
const manifestPath = join(bundle, "SHA256SUMS");
await requireRegular(manifestPath, "SHA256SUMS");
const manifest = (await readFile(manifestPath, "utf8"))
  .split("\n")
  .filter((line) => line.length > 0)
  .map(parseManifestLine);
if (manifest.length !== expected.size || manifest.some(([path]) => !expected.has(path))) {
  throw new Error(
    "SHA256SUMS must contain exactly the executable, image recipe/dependencies, and README.md.",
  );
}
for (const [relative, expectedRecipeDigest] of expected) {
  const path = join(bundle, relative);
  await requireRegular(path, relative);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  const entry = manifest.find(([name]) => name === relative);
  if (entry?.[1] !== digest) throw new Error(`Release file hash mismatch: ${relative}`);
  if (expectedRecipeDigest !== "" && digest !== expectedRecipeDigest) {
    throw new Error(`Release Containerfile is not the audited recipe: ${relative}`);
  }
}
console.log(`Verified ${bundle}`);

function parseManifestLine(line: string): [string, string] {
  const match = /^(?<digest>[0-9a-f]{64})  (?<path>[^/].*)$/.exec(line);
  const path = match?.groups?.path;
  const digest = match?.groups?.digest;
  if (path === undefined || digest === undefined || path.includes("..") || path.startsWith("/")) {
    throw new Error(`Invalid SHA256SUMS entry: ${line}`);
  }
  return [path, digest];
}

async function requireRegular(path: string, description: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isFile()) {
    throw new Error(`${description} must be a regular non-symlink file: ${path}`);
  }
}
