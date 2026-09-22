import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthProfile } from "../auth/profiles.ts";
import { runAgent, runCliAgent } from "./run.ts";

let state: string | undefined;
afterEach(async () => {
  if (state !== undefined) await rm(state, { recursive: true, force: true });
  delete Bun.env.XDG_STATE_HOME;
  state = undefined;
});

async function profile(): Promise<void> {
  state = await mkdtemp(join(tmpdir(), "pi-pod-run-auth-"));
  Bun.env.XDG_STATE_HOME = state;
  await createAuthProfile({
    agent: "opencode",
    name: "worker",
    provider: "anthropic",
    token: "fake",
  });
}

async function withFakePodman(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-run-"));
  const bin = join(root, "bin");
  const previousPath = Bun.env.PATH;
  const previousState = Bun.env.XDG_STATE_HOME;
  try {
    await mkdir(bin);
    await writeFile(
      join(bin, "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf 'fixture stdout'; exit 0 ;;
  container) exit 1 ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, "podman"), 0o700);
    Bun.env.PATH = `${bin}:${previousPath ?? ""}`;
    Bun.env.XDG_STATE_HOME = join(root, "state");
    await action(root);
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    if (previousState === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  }
}

test("an aborted headless library call does not create state or invoke Podman", async () => {
  await withFakePodman(async (root) => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller cancelled", "AbortError"));
    await expect(
      runAgent({
        mode: "headless",
        workspace: join(root, "workspace"),
        auth: { type: "profile", name: "missing" },
        prompt: "test",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled");
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
  });
});

test("a successful profile run streams output and discards its stage", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const stored = await createAuthProfile({
      agent: "opencode",
      name: "worker",
      provider: "anthropic",
      token: "fake",
    });
    const chunks: Uint8Array[] = [];
    const result = await runAgent({
      agent: "opencode",
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      auth: { type: "profile", name: "worker" },
      prompt: "test",
      output: {
        stdout: new WritableStream({
          write: (chunk) => {
            chunks.push(new Uint8Array(chunk));
          },
        }),
      },
    });
    expect(new TextDecoder().decode(chunks[0])).toBe("fixture stdout");
    expect(result.cleanup.containerRemoved).toBe(true);
    expect(result.auth).toEqual({
      source: "profile",
      reconciliation: "not-used",
      lock: "not-used",
    });
    expect(await Bun.file(stored.authFile).text()).toContain("fake");
  });
});

test("cancellation removes an exact container before discarding a profile stage", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await createAuthProfile({
      agent: "opencode",
      name: "worker",
      provider: "anthropic",
      token: "fake",
    });
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) while :; do :; done ;;
  container) exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(new Error("fixture cancellation")), 100);
    try {
      const result = await runAgent({
        agent: "opencode",
        mode: "headless",
        workspace,
        workspaceMode: "bind",
        auth: { type: "profile", name: "worker" },
        prompt: "test",
        signal: controller.signal,
        output: { stdout: new WritableStream({ write: () => {} }) },
      });
      expect(result.termination).toBe("aborted");
      expect(result.cleanup.containerRemoved).toBe(true);
      expect(result.auth.reconciliation).toBe("not-used");
    } finally {
      clearTimeout(abort);
    }
  });
});

test("timeout removes an exact container before discarding a profile stage", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await createAuthProfile({
      agent: "opencode",
      name: "worker",
      provider: "anthropic",
      token: "fake",
    });
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) while :; do :; done ;;
  container) exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o700 },
    );
    const result = await runAgent({
      agent: "opencode",
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      auth: { type: "profile", name: "worker" },
      prompt: "test",
      timeoutMs: 100,
      output: { stdout: new WritableStream({ write: () => {} }) },
    });
    expect(result.termination).toBe("timeout");
    expect(result.cleanup.containerRemoved).toBe(true);
    expect(result.auth.reconciliation).toBe("not-used");
  });
});

test("headless library profile failures happen before workspace or Podman work", async () => {
  await expect(
    runAgent({
      mode: "headless",
      workspace: "/definitely/not/a/workspace",
      auth: { type: "profile", name: "missing" },
      prompt: "test",
    }),
  ).rejects.toThrow("Auth profile");
});

test("native model overrides are checked against the effective profile provider", async () => {
  await profile();
  await expect(
    runAgent({
      agent: "opencode",
      mode: "headless",
      workspace: "/definitely/not/a/workspace",
      auth: { type: "profile", name: "worker" },
      preferences: { model: { provider: "anthropic", id: "fixture" } },
      agentArgs: ["--model", "openai/fixture"],
      prompt: "test",
    }),
  ).rejects.toThrow("does not match authentication provider anthropic");
});

test("CLI host auth checks an explicit conflicting model provider", async () => {
  await expect(
    runCliAgent({
      agent: "opencode",
      mode: "headless",
      workspace: "/definitely/not/a/workspace",
      auth: { type: "host" },
      preferences: { model: { provider: "anthropic", id: "fixture" } },
      prompt: "test",
    }),
  ).rejects.toThrow("does not match authentication provider openai");
});

test("Pi host auth checks an explicit native provider override", async () => {
  await expect(
    runCliAgent({
      agent: "pi",
      mode: "headless",
      workspace: "/definitely/not/a/workspace",
      auth: { type: "host" },
      agentArgs: ["--provider", "anthropic"],
      prompt: "test",
    }),
  ).rejects.toThrow("does not match authentication provider openai-codex");
});

test("headless library host auth is rejected before side effects", async () => {
  await expect(
    runAgent({
      mode: "headless",
      workspace: "/definitely/not/a/workspace",
      auth: { type: "host" },
      prompt: "test",
    } as never),
  ).rejects.toThrow("require an explicit API-token profile");
});
