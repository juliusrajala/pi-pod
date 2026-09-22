import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageManifest from "../package.json" with { type: "json" };
import { auditedContainerfileSha256 } from "../src/cli/distribution.ts";
const pinnedBun = "1.3.14";
const targetName = "linux-x64";
const bunTarget = "bun-linux-x64";

await buildRelease(process.argv.slice(2));

async function buildRelease(argv: readonly string[]): Promise<void> {
  if (Bun.version !== pinnedBun) {
    throw new Error(`Release builds require Bun ${pinnedBun}; found ${Bun.version}.`);
  }
  const root = await realPath(dirname(import.meta.dir));
  if ((await realPath(process.cwd())) !== root) {
    throw new Error(`Run the release build from the repository root: ${root}`);
  }
  if (argv.length !== 2 || argv[0] !== "--target" || argv[1] !== targetName) {
    throw new Error(`Usage: bun run build:release -- --target ${targetName}`);
  }

  const output = join(root, "dist", `pi-pod-${packageManifest.version}-${targetName}`);
  await requireDirectory(dirname(output));
  await requireAbsent(output);

  const temporary = await mkdtemp(join(tmpdir(), "pi-pod-release-"));
  const executable = join(temporary, "pi-pod");
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        `--target=${bunTarget}`,
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
        "--outfile",
        executable,
        join(root, "src", "cli", "compiled.ts"),
      ],
      { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    if ((await build.exited) !== 0) throw new Error("Compiled pi-pod build failed.");

    await mkdir(join(output, "container"), { recursive: true });
    await copyFile(executable, join(output, "pi-pod"));
    await chmod(join(output, "pi-pod"), 0o755);
    await copyFile(
      join(root, "container", "Containerfile"),
      join(output, "container", "Containerfile"),
    );
    await copyFile(
      join(root, "container", "package.json"),
      join(output, "container", "package.json"),
    );
    await copyFile(join(root, "container", "bun.lock"), join(output, "container", "bun.lock"));
    const recipeDigest = createHash("sha256")
      .update(await readFile(join(output, "container", "Containerfile")))
      .digest("hex");
    if (recipeDigest !== auditedContainerfileSha256) {
      throw new Error("The repository Containerfile is not the audited release recipe.");
    }
    await copyFile(join(import.meta.dir, "release-README.md"), join(output, "README.md"));
    await writeChecksums(output);
    await verifySmoke(output);
    console.log(`Built ${output}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeChecksums(bundle: string): Promise<void> {
  const entries = [
    "pi-pod",
    "container/Containerfile",
    "container/package.json",
    "container/bun.lock",
    "README.md",
  ];
  const lines: string[] = [];
  for (const relative of entries) {
    const digest = createHash("sha256")
      .update(await readFile(join(bundle, relative)))
      .digest("hex");
    lines.push(`${digest}  ${relative}`);
  }
  await writeFile(join(bundle, "SHA256SUMS"), `${lines.join("\n")}\n`, { mode: 0o644 });
}

async function verifySmoke(bundle: string): Promise<void> {
  const hostile = await mkdtemp(join(tmpdir(), "pi-pod-release-smoke-"));
  try {
    await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./must-not-run.ts"]\n');
    await writeFile(join(hostile, "must-not-run.ts"), "throw new Error('hostile preload');\n");
    await writeFile(join(hostile, ".env"), "PI_POD_RELEASE_HOSTILE=1\n");
    const child = Bun.spawn([join(bundle, "pi-pod"), "--help"], {
      cwd: hostile,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0 || !stdout.startsWith("Usage:")) {
      throw new Error(`Compiled release smoke test failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
  } finally {
    await rm(hostile, { recursive: true, force: true });
  }
}

async function requireDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory())
      throw new Error(`Release output parent is not a regular directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(path, { recursive: true });
      return;
    }
    throw error;
  }
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing release output: ${path}`);
}

async function realPath(path: string): Promise<string> {
  return realpath(path);
}
