import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPodmanContainer } from "./lifecycle.ts";

const originalPath = Bun.env.PATH;

test("waits for a delayed container creation before terminating an aborted run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-lifecycle-"));
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  const container = join(root, "container-exists");
  await mkdir(bin);
  await writeFile(
    join(bin, "podman"),
    `#!/bin/sh
printf '%s\\n' "$1" >> ${shellQuote(trace)}
case "$1" in
  run)
    trap '' TERM
    sleep 0.15
    touch ${shellQuote(container)}
    while test -e ${shellQuote(container)}; do sleep 0.01; done
    ;;
  container) test -e ${shellQuote(container)} ;;
  stop|kill|rm) rm -f ${shellQuote(container)} ;;
esac
`,
    { mode: 0o700 },
  );

  Bun.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("test abort")), 20);
    const result = await runPodmanContainer({
      args: ["run", "--name", "fixture"],
      name: "fixture",
      environment: { PATH: Bun.env.PATH },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    expect(result.aborted).toBe(true);
    expect(result.cleanup.removed).toBe(true);
    expect(await Bun.file(container).exists()).toBe(false);
    const commands = await Bun.file(trace).text();
    expect(commands).toContain("run\n");
    expect(commands).toContain("stop\n");
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a container left behind after the attached client exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-lifecycle-leftover-"));
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  const container = join(root, "container-exists");
  await mkdir(bin);
  await writeFile(
    join(bin, "podman"),
    `#!/bin/sh
printf '%s\\n' "$1" >> ${shellQuote(trace)}
case "$1" in
  run) touch ${shellQuote(container)} ;;
  container) test -e ${shellQuote(container)} ;;
  stop|kill|rm) rm -f ${shellQuote(container)} ;;
esac
`,
    { mode: 0o700 },
  );
  Bun.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    const result = await runPodmanContainer({
      args: ["run", "--name", "fixture"],
      name: "fixture",
      environment: { PATH: Bun.env.PATH },
    });

    expect(result.aborted).toBe(false);
    expect(result.cleanup.removed).toBe(true);
    expect(await Bun.file(container).exists()).toBe(false);
    expect(await Bun.file(trace).text()).toContain("stop\n");
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("streams attached client output to caller-provided sinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-lifecycle-output-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "podman"),
    `#!/bin/sh
case "$1" in
  run) printf 'agent stdout'; printf 'agent stderr' >&2 ;;
  container) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  const previousPath = Bun.env.PATH;
  Bun.env.PATH = `${bin}:${previousPath ?? ""}`;
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  try {
    const result = await runPodmanContainer({
      args: ["run"],
      name: "fixture",
      environment: { PATH: Bun.env.PATH },
      output: {
        stdout: new WritableStream({
          write: (chunk) => {
            stdout.push(new Uint8Array(chunk));
          },
        }),
        stderr: new WritableStream({
          write: (chunk) => {
            stderr.push(new Uint8Array(chunk));
          },
        }),
      },
    });

    expect(result.cleanup.removed).toBe(true);
    expect(new TextDecoder().decode(concat(stdout))).toBe("agent stdout");
    expect(new TextDecoder().decode(concat(stderr))).toBe("agent stderr");
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a failed output sink after removing the container", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-lifecycle-sink-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "podman"),
    `#!/bin/sh
case "$1" in
  run) printf 'agent stdout' ;;
  container) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  const previousPath = Bun.env.PATH;
  Bun.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await runPodmanContainer({
      args: ["run"],
      name: "fixture",
      environment: { PATH: Bun.env.PATH },
      output: {
        stdout: new WritableStream({
          write: () => {
            throw new Error("sink failed");
          },
        }),
        stderr: new WritableStream({ write: () => {} }),
      },
    });

    expect(result.cleanup.removed).toBe(true);
    expect(result.outputError).toContain("sink failed");
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
