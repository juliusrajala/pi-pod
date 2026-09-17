import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAuthProfile } from "../auth/recovery.ts";
import { login } from "./login.ts";
import { runAgent } from "./run.ts";
import { removeRun } from "../workspace/runs.ts";

async function withFakePodman(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-run-"));
  const bin = join(root, "bin");
  const previousPath = Bun.env.PATH;
  const previousStateHome = Bun.env.XDG_STATE_HOME;
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
    );
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
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
touch ${marker}
exit 1
`,
      { mode: 0o700 },
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const controller = new AbortController();
    controller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(
      runAgent({
        mode: "headless",
        workspace,
        authProfile: "none",
        prompt: "should not stage",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
  });
});

test("does not create an auth profile when login is already aborted", async () => {
  await withFakePodman(async (root) => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(
      login({
        agent: "pi",
        provider: "openai-codex",
        profile: "cancelled",
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled");
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
      "openai-codex": {
        type: "oauth",
        access: "host-access",
        refresh: "host-refresh",
        expires: 1_900_000_000_000,
      },
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

test("stages the host OpenCode OpenAI session for interactive dev without mounting host state", async () => {
  await withFakePodman(async (root) => {
    const previousDataHome = Bun.env.XDG_DATA_HOME;
    const dataHome = join(root, "host-data");
    const hostAuth = join(dataHome, "opencode", "auth.json");
    const hostSettings = join(dataHome, "opencode", "settings.json");
    const workspace = join(root, "workspace");
    const trace = join(root, "podman-arguments");
    const source = `${redactedOpenCodeHostAuthDocument()}\n`;
    try {
      Bun.env.XDG_DATA_HOME = dataHome;
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      await mkdir(workspace);
      await writeFile(hostAuth, source);
      await writeFile(hostSettings, "must-not-mount");
      await writeFile(
        join(root, "bin", "podman"),
        `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );

      const result = await runAgent({
        agent: "opencode",
        mode: "interactive",
        workspace,
        workspaceMode: "bind",
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      expect(result.auth).toEqual({ source: "host", reconciliation: "not-used", lock: "not-used" });
      expect(await Bun.file(hostAuth).text()).toBe(source);
      const argumentsUsed = await Bun.file(trace).text();
      expect(argumentsUsed).toContain("auth-staging/");
      expect(argumentsUsed).toContain("dst=/home/agent/.local/share/opencode,rw,relabel=private");
      expect(argumentsUsed).not.toContain(dataHome);
      expect(argumentsUsed).not.toContain(hostSettings);
    } finally {
      if (previousDataHome === undefined) delete Bun.env.XDG_DATA_HOME;
      else Bun.env.XDG_DATA_HOME = previousDataHome;
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
      await writeFile(
        hostAuth,
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "host-access",
            refresh: "host-refresh",
            expires: 1_900_000_000_000,
          },
        }),
      );
      await writeFile(join(hostExtensions, "fixture.ts"), "export default () => {};\n");
      await writeFile(
        join(root, "bin", "podman"),
        `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );

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

test("rejects host credentials for a headless autonomous OpenCode run", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    const marker = join(root, "podman-invoked");
    await mkdir(workspace);
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
touch ${marker}
exit 1
`,
      { mode: 0o700 },
    );

    await expect(
      runAgent({
        agent: "opencode",
        mode: "headless",
        workspace,
        workspaceMode: "bind",
        authProfile: "host",
        prompt: "must not use host state",
      }),
    ).rejects.toThrow("only to interactive dev sessions");
    expect(await lstat(join(root, "state", "pi-pod")).catch(() => undefined)).toBeUndefined();
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test("default headless OpenCode runs neither read nor mount host OpenCode state", async () => {
  await withFakePodman(async (root) => {
    const previousDataHome = Bun.env.XDG_DATA_HOME;
    const dataHome = join(root, "host-data");
    const hostAuth = join(dataHome, "opencode", "auth.json");
    const hostSettings = join(dataHome, "opencode", "settings.json");
    const workspace = join(root, "workspace");
    const trace = join(root, "podman-arguments");
    try {
      Bun.env.XDG_DATA_HOME = dataHome;
      await mkdir(join(dataHome, "opencode"), { recursive: true });
      await mkdir(workspace);
      // Invalid host content makes any accidental read fail the run.
      await writeFile(hostAuth, "host-auth-must-not-be-read");
      await writeFile(hostSettings, "host-settings-must-not-be-mounted");
      await createAuthProfile({ agent: "opencode", name: "default", provider: "openai" });
      await writeFile(
        join(root, "bin", "podman"),
        `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );

      const result = await runAgent({
        agent: "opencode",
        mode: "headless",
        workspace,
        workspaceMode: "bind",
        prompt: "fixture task",
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      expect(result.auth.source).toBe("profile");
      const argumentsUsed = await Bun.file(trace).text();
      expect(argumentsUsed).not.toContain(dataHome);
      expect(argumentsUsed).not.toContain(hostAuth);
      expect(argumentsUsed).not.toContain(hostSettings);
    } finally {
      if (previousDataHome === undefined) delete Bun.env.XDG_DATA_HOME;
      else Bun.env.XDG_DATA_HOME = previousDataHome;
    }
  });
});

test("headless runs never mount dev-only host Pi resources", async () => {
  await withFakePodman(async (root) => {
    const previousHome = Bun.env.HOME;
    const home = join(root, "home");
    const extensions = join(home, ".pi", "agent", "extensions");
    const settings = join(home, ".pi", "agent", "settings.json");
    const workspace = join(root, "workspace");
    const trace = join(root, "podman-arguments");
    try {
      Bun.env.HOME = home;
      await mkdir(extensions, { recursive: true });
      await mkdir(workspace);
      await writeFile(join(extensions, "host-only.ts"), "export default {};\n");
      await writeFile(settings, JSON.stringify({ extensions: ["./extensions/host-only.ts"] }));
      await writeFile(
        join(root, "bin", "podman"),
        `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );

      await runAgent({
        mode: "headless",
        workspace,
        workspaceMode: "bind",
        authProfile: "none",
        prompt: "fixture task",
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      const argumentsUsed = await Bun.file(trace).text();
      expect(argumentsUsed).not.toContain(home);
      expect(argumentsUsed).toContain("--no-extensions");
    } finally {
      if (previousHome === undefined) delete Bun.env.HOME;
      else Bun.env.HOME = previousHome;
    }
  });
});

test("forwards an explicit API key only through the Podman client environment", async () => {
  await withFakePodman(async (root) => {
    const previousApiKey = Bun.env.OPENAI_API_KEY;
    const previousUnrelated = Bun.env.STRIPE_SECRET_KEY;
    const workspace = join(root, "workspace");
    const argsTrace = join(root, "podman-arguments");
    const environmentTrace = join(root, "podman-environment");
    const diagnostics: string[] = [];
    try {
      Bun.env.OPENAI_API_KEY = "fake-explicit-api-key";
      Bun.env.STRIPE_SECRET_KEY = "fake-unrelated-secret";
      await mkdir(workspace);
      await writeFile(
        join(root, "bin", "podman"),
        `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(argsTrace)}; env > ${JSON.stringify(environmentTrace)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );

      await runAgent({
        mode: "headless",
        workspace,
        workspaceMode: "bind",
        authProfile: "none",
        environment: ["OPENAI_API_KEY"],
        prompt: "fixture task",
        onDiagnostic: (message) => {
          diagnostics.push(message);
        },
        output: { stdout: new WritableStream({ write: () => {} }) },
      });

      const args = await Bun.file(argsTrace).text();
      const environment = await Bun.file(environmentTrace).text();
      expect(args).toContain("OPENAI_API_KEY");
      expect(args).not.toContain("fake-explicit-api-key");
      expect(environment).toContain("OPENAI_API_KEY=fake-explicit-api-key");
      expect(environment).not.toContain("STRIPE_SECRET_KEY=fake-unrelated-secret");
      expect(diagnostics.join("\n")).not.toContain("fake-explicit-api-key");
    } finally {
      if (previousApiKey === undefined) delete Bun.env.OPENAI_API_KEY;
      else Bun.env.OPENAI_API_KEY = previousApiKey;
      if (previousUnrelated === undefined) delete Bun.env.STRIPE_SECRET_KEY;
      else Bun.env.STRIPE_SECRET_KEY = previousUnrelated;
    }
  });
});

test("reconciles a profile only after a leftover exact named container is removed", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    const container = join(root, "container-exists");
    const containerName = join(root, "container-name");
    const stageAuth = join(root, "stage-auth");
    await mkdir(workspace);
    const profile = await createAuthProfile({
      agent: "pi",
      name: "leftover",
      provider: "openai-codex",
    });
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run)
    shift
    while test "$#" -gt 0; do
      if test "$1" = --name; then printf '%s' "$2" > ${JSON.stringify(containerName)}; shift 2; continue; fi
      if test "$1" = --mount; then
        case "$2" in
          *dst=/home/agent/.pi/agent*) stage=\${2#type=bind,src=}; stage=\${stage%,dst=*}; printf '%s' "$stage/auth.json" > ${JSON.stringify(stageAuth)} ;;
        esac
        shift 2; continue
      fi
      shift
    done
    printf '%s' '{"openai-codex":{"type":"oauth","access":"new-access","refresh":"new-refresh","expires":1234}}' > "$(cat ${JSON.stringify(stageAuth)})"
    touch ${JSON.stringify(container)}
    ;;
  container)
    test "$3" = "$(cat ${JSON.stringify(containerName)})" && test -e ${JSON.stringify(container)} && test -f "$(cat ${JSON.stringify(stageAuth)})"
    ;;
  stop|kill|rm) rm -f ${JSON.stringify(container)} ;;
esac
`,
      { mode: 0o700 },
    );

    const result = await runAgent({
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "leftover",
      prompt: "fixture task",
      output: { stdout: new WritableStream({ write: () => {} }) },
    });

    expect(result.cleanup.containerRemoved).toBe(true);
    expect(await Bun.file(container).exists()).toBe(false);
    expect(await Bun.file(profile.authFile).json()).toEqual({
      "openai-codex": {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: 1234,
      },
    });
  });
});

test("preserves a profile stage through cancellation until its exact container is absent", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    const container = join(root, "container-exists");
    const containerName = join(root, "container-name");
    const stageAuth = join(root, "stage-auth");
    await mkdir(workspace);
    const profile = await createAuthProfile({
      agent: "pi",
      name: "cancelled",
      provider: "openai-codex",
    });
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run)
    shift
    while test "$#" -gt 0; do
      if test "$1" = --name; then printf '%s' "$2" > ${JSON.stringify(containerName)}; shift 2; continue; fi
      if test "$1" = --mount; then
        case "$2" in
          *dst=/home/agent/.pi/agent*) stage=\${2#type=bind,src=}; stage=\${stage%,dst=*}; printf '%s' "$stage/auth.json" > ${JSON.stringify(stageAuth)} ;;
        esac
        shift 2; continue
      fi
      shift
    done
    printf '%s' '{"openai-codex":{"type":"oauth","access":"cancel-access","refresh":"cancel-refresh","expires":1234}}' > "$(cat ${JSON.stringify(stageAuth)})"
    touch ${JSON.stringify(container)}
    # Keep the attached client alive without a child process holding its pipes
    # after lifecycle sends SIGTERM to the client.
    while :; do :; done
    ;;
  container)
    test "$3" = "$(cat ${JSON.stringify(containerName)})" && test -e ${JSON.stringify(container)} && test -f "$(cat ${JSON.stringify(stageAuth)})"
    ;;
  stop|kill|rm) rm -f ${JSON.stringify(container)} ;;
esac
`,
      { mode: 0o700 },
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("cancel fixture")), 100);
    const result = await runAgent({
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "cancelled",
      prompt: "fixture task",
      signal: controller.signal,
      output: { stdout: new WritableStream({ write: () => {} }) },
    });
    clearTimeout(timeout);

    expect(result.termination).toBe("aborted");
    expect(result.cleanup.containerRemoved).toBe(true);
    expect(await Bun.file(container).exists()).toBe(false);
    expect(await Bun.file(profile.authFile).json()).toEqual({
      "openai-codex": {
        type: "oauth",
        access: "cancel-access",
        refresh: "cancel-refresh",
        expires: 1234,
      },
    });
  });
});

test("reconciles a timed-out profile only after its exact container is removed", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    const container = join(root, "container-exists");
    const containerName = join(root, "container-name");
    const stageAuth = join(root, "stage-auth");
    await mkdir(workspace);
    const profile = await createAuthProfile({
      agent: "pi",
      name: "timed-out",
      provider: "openai-codex",
    });
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run)
    shift
    while test "$#" -gt 0; do
      if test "$1" = --name; then printf '%s' "$2" > ${JSON.stringify(containerName)}; shift 2; continue; fi
      if test "$1" = --mount; then
        case "$2" in
          *dst=/home/agent/.pi/agent*) stage=\${2#type=bind,src=}; stage=\${stage%,dst=*}; printf '%s' "$stage/auth.json" > ${JSON.stringify(stageAuth)} ;;
        esac
        shift 2; continue
      fi
      shift
    done
    printf '%s' '{"openai-codex":{"type":"oauth","access":"timeout-access","refresh":"timeout-refresh","expires":1234}}' > "$(cat ${JSON.stringify(stageAuth)})"
    touch ${JSON.stringify(container)}
    # Do not leave a child process holding the output pipes after timeout.
    while :; do :; done
    ;;
  container)
    test "$3" = "$(cat ${JSON.stringify(containerName)})" && test -e ${JSON.stringify(container)} && test -f "$(cat ${JSON.stringify(stageAuth)})"
    ;;
  stop|kill|rm) rm -f ${JSON.stringify(container)} ;;
esac
`,
      { mode: 0o700 },
    );

    const result = await runAgent({
      mode: "headless",
      workspace,
      workspaceMode: "bind",
      authProfile: "timed-out",
      prompt: "fixture task",
      timeoutMs: 100,
      output: { stdout: new WritableStream({ write: () => {} }) },
    });

    expect(result.termination).toBe("timeout");
    expect(result.cleanup.containerRemoved).toBe(true);
    expect(await Bun.file(container).exists()).toBe(false);
    expect(await Bun.file(profile.authFile).json()).toEqual({
      "openai-codex": {
        type: "oauth",
        access: "timeout-access",
        refresh: "timeout-refresh",
        expires: 1234,
      },
    });
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
        stdout: new WritableStream({
          write: (chunk) => {
            chunks.push(new Uint8Array(chunk));
          },
        }),
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

function redactedOpenCodeHostAuthDocument(): string {
  // Generate opaque values at runtime so fixtures cannot be mistaken for credentials.
  const redacted = crypto.randomUUID();
  return JSON.stringify({
    openai: { type: "oauth", access: redacted, refresh: redacted, expires: 1_900_000_000_000 },
    unrelated: { sentinel: true },
  });
}

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

    expect(result.workspace.mode).toBe("clone");
    if (result.workspace.mode !== "clone") throw new Error("Expected retained clone.");
    expect(result.cleanup.reservation).toBe("released");
    expect((await lstat(result.workspace.path)).isDirectory()).toBe(true);
    await removeRun(result.workspace.runId);
    expect(await lstat(result.workspace.path).catch(() => undefined)).toBeUndefined();
  });
});

test("reports retained auth staging instead of hiding failed reconciliation", async () => {
  await withFakePodman(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const profile = await createAuthProfile({
      agent: "pi",
      name: "fixture",
      provider: "openai-codex",
    });
    const stagePath = join(root, "staged-agent-directory");
    await writeFile(
      join(root, "bin", "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) for arg in "$@"; do case "$arg" in *dst=/home/agent/.pi/agent*) stage=\${arg#type=bind,src=}; stage=\${stage%,dst=*}; printf '%s' "$stage" > ${JSON.stringify(stagePath)} ;; esac; done ;;
  container) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );

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
    // Cleanup verified the exact run container absent, but an invalid native
    // update must remain recoverable rather than overwrite the known profile.
    expect(await Bun.file(profile.authFile).text()).toBe("{}\n");
    const agentStateDirectory = await Bun.file(stagePath).text();
    expect(await Bun.file(join(agentStateDirectory, "auth.json")).exists()).toBe(true);
    expect((await lstat(dirname(agentStateDirectory))).isDirectory()).toBe(true);
  });
});
