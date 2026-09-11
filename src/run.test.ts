import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthProfile } from "./auth.ts";
import { login, runAgent } from "./run.ts";
import { removeRun } from "./workspace.ts";

async function withFakePodman(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-run-"));
  const bin = join(root, "bin");
  const previousPath = Bun.env.PATH;
  const previousStateHome = Bun.env.XDG_STATE_HOME;
  try {
    await mkdir(bin);
    await writeFile(join(bin, "podman"), `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf 'fixture stdout'; exit 0 ;;
  container) exit 1 ;;
  *) exit 1 ;;
esac
`);
    await chmod(join(bin, "podman"), 0o755);
    Bun.env.PATH = `${bin}:${previousPath}`;
    Bun.env.XDG_STATE_HOME = join(root, "state");
    await action(root);
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = previousStateHome;
    await rm(root, { recursive: true, force: true });
  }
}

test("does not stage state or invoke Podman when already aborted", async () => {
  await withFakePodman(async (root) => {
    const marker = join(root, "podman-invoked");
    await writeFile(join(root, "bin", "podman"), `#!/bin/sh
touch ${marker}
exit 1
`, { mode: 0o700 });
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const controller = new AbortController();
    controller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(runAgent({
      mode: "headless",
      workspace,
      authProfile: "none",
      prompt: "should not stage",
      signal: controller.signal,
    })).rejects.toThrow("caller cancelled");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
  });
});

test("does not create an auth profile when login is already aborted", async () => {
  await withFakePodman(async (root) => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(login({
      agent: "pi",
      provider: "openai-codex",
      profile: "cancelled",
      signal: controller.signal,
    })).rejects.toThrow("caller cancelled");
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
  });
});

test("stages the host Pi credential for interactive dev without changing its source", async () => {
  await withFakePodman(async (root) => {
    const previousHome = Bun.env.HOME;
    const home = join(root, "home");
    const hostAuth = join(home, ".pi", "agent", "auth.json");
    const workspace = join(root, "workspace");
    const source = `${JSON.stringify({
      "openai-codex": { type: "oauth", access: "host-access", refresh: "host-refresh", expires: 1_900_000_000_000 },
      unrelated: { token: "never-stage-this" },
    })}\n`;
    try {
      Bun.env.HOME = home;
      await mkdir(join(home, ".pi", "agent"), { recursive: true });
      await mkdir(workspace);
      await writeFile(hostAuth, source);

      const result = await runAgent({
        mode: "interactive",
        workspace,
        workspaceMode: "bind",
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      expect(result.auth).toEqual({ source: "host", reconciliation: "not-used", lock: "not-used" });
      expect(await Bun.file(hostAuth).text()).toBe(source);
    } finally {
      if (previousHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = previousHome;
    }
  });
});

test("does not mount host extensions when dev explicitly passes Pi --no-extensions", async () => {
  await withFakePodman(async (root) => {
    const previousHome = Bun.env.HOME;
    const home = join(root, "home");
    const hostAuth = join(home, ".pi", "agent", "auth.json");
    const hostExtensions = join(home, ".pi", "agent", "extensions");
    const workspace = join(root, "workspace");
    const trace = join(root, "podman-arguments");
    try {
      Bun.env.HOME = home;
      await mkdir(hostExtensions, { recursive: true });
      await mkdir(workspace);
      await writeFile(hostAuth, JSON.stringify({
        "openai-codex": { type: "oauth", access: "host-access", refresh: "host-refresh", expires: 1_900_000_000_000 },
      }));
      await writeFile(join(hostExtensions, "fixture.ts"), "export default () => {};\n");
      await writeFile(join(root, "bin", "podman"), `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`, { mode: 0o700 });

      await runAgent({
        mode: "interactive",
        workspace,
        workspaceMode: "bind",
        agentArgs: ["--no-extensions"],
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      const argumentsUsed = await Bun.file(trace).text();
      expect(argumentsUsed).toContain("--no-extensions");
      expect(argumentsUsed).not.toContain(hostExtensions);
    } finally {
      if (previousHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = previousHome;
    }
  });
});

test("rejects host credentials for a headless autonomous run", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(runAgent({
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "host",
      prompt: "must not use host state",
    })).rejects.toThrow("only to interactive Pi dev sessions");
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
  });
});

test("reports an explicit no-auth outcome and streams output without buffering", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const chunks: Uint8Array[] = [];

    const result = await runAgent({
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "none",
      prompt: "fixture task",
      output: {
        stdout: new WritableStream({ write: (chunk) => { chunks.push(new Uint8Array(chunk)); } }),
      },
    });

    expect(new TextDecoder().decode(concat(chunks))).toBe("fixture stdout");
    expect(result.exitCode).toBe(0);
    expect(result.cleanup.containerRemoved).toBe(true);
    expect(result.cleanup.reservation).toBe("not-owned");
    expect(result.output).toEqual({ mode: "streamed" });
    expect(result.auth).toEqual({ source: "none", reconciliation: "not-used", lock: "not-used" });
  });
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

test("reports an owned clone reservation released after verified container cleanup", async () => {
  await withFakePodman(async (root) => {
    const source = join(root, "source");
    await mkdir(source);
    await Bun.$`git init --quiet ${source}`;
    await Bun.$`git -C ${source} config user.name Fixture`;
    await Bun.$`git -C ${source} config user.email fixture@example.invalid`;
    await writeFile(join(source, "tracked.txt"), "fixture\n");
    await Bun.$`git -C ${source} add tracked.txt`;
    await Bun.$`git -C ${source} commit --quiet -m fixture`;

    const result = await runAgent({
      mode: "headless",
      workspace: source,
      workspaceMode: "clone",
      authProfile: "none",
      prompt: "fixture task",
      output: { stdout: new WritableStream({ write: () => {} }) },
    });

    expect(result.workspace.owned).toBe(true);
    expect(result.cleanup.reservation).toBe("released");
    expect((await lstat(result.workspace.path)).isDirectory()).toBe(true);
    await removeRun(result.workspace.runId!);
    expect(await lstat(result.workspace.path).catch(() => undefined)).toBeUndefined();
  });
});

test("reports retained auth staging instead of hiding failed reconciliation", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await createAuthProfile({ agent: "pi", name: "fixture", provider: "openai-codex" });

    const result = await runAgent({
      agent: "pi",
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "fixture",
      prompt: "fixture task",
      output: { stdout: new WritableStream({ write: () => {} }) },
    });

    expect(result.exitCode).toBe(0);
    expect(result.auth.reconciliation).toBe("retained");
    expect(result.auth.lock).toBe("released");
    expect(result.auth.error).toContain("did not create a credential");
  });
});
