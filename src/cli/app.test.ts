import { expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, resolveCommand } from "@crustjs/core";
import { app, normalizeConfigOptOut } from "./app.ts";
import { isWrapperHelpRequest } from "./help.ts";

function packageRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

function sourceLauncher(): string {
  return join(packageRoot(), "scripts", "dev-launcher");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("launcher starts without loading caller Bun config or creating runtime home", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-"));
  try {
    const home = join(root, "home");
    const workspaceMarker = join(root, "workspace-preload-ran");
    const homeMarker = join(root, "home-preload-ran");
    await mkdir(home);
    await writeFile(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(
      join(root, "preload.ts"),
      `await Bun.write(${JSON.stringify(workspaceMarker)}, "ran");\n`,
    );
    await writeFile(
      join(home, ".bunfig.toml"),
      `preload = [${JSON.stringify(join(home, "home-preload.ts"))}]\n`,
    );
    await writeFile(
      join(home, "home-preload.ts"),
      `await Bun.write(${JSON.stringify(homeMarker)}, "ran");\n`,
    );

    const child = Bun.spawn([sourceLauncher(), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, PI_POD_BUN_PATH: process.execPath },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toStartWith("Usage:");
    expect(await Bun.file(workspaceMarker).exists()).toBe(false);
    expect(await Bun.file(homeMarker).exists()).toBe(false);
    expect(await pathExists(join(packageRoot(), ".runtime-home"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher ignores a caller PATH Bun from the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-hostile-path-"));
  try {
    const bin = join(root, "bin");
    const marker = join(root, "path-bun-ran");
    await mkdir(bin);
    await writeFile(join(bin, "bun"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 99\n`, {
      mode: 0o700,
    });

    const child = Bun.spawn([sourceLauncher(), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PI_POD_BUN_PATH: process.execPath,
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toStartWith("Usage:");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher skips a stale BUN_INSTALL Bun for a valid Mise shim", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-mise-bun-"));
  const staleRoot = await mkdtemp(join(tmpdir(), "pi-pod-cli-stale-bun-"));
  const miseRoot = await mkdtemp(join(tmpdir(), "pi-pod-cli-mise-root-"));
  try {
    const staleBin = join(staleRoot, "bin");
    const miseShims = join(miseRoot, "shims");
    const staleMarker = join(root, "stale-bun-probed");
    const miseCwd = join(root, "mise-cwd");
    await mkdir(staleBin, { recursive: true });
    await mkdir(miseShims, { recursive: true });
    await writeFile(
      join(staleBin, "bun"),
      `#!/bin/sh\n: > ${JSON.stringify(staleMarker)}\necho 1.3.9\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(miseShims, "bun"),
      `#!/bin/sh\nprintf '%s' "$PWD" > ${JSON.stringify(miseCwd)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
    const env = { ...process.env };
    delete env.PI_POD_BUN_PATH;
    delete env.BUN_INSTALL_BIN;
    env.BUN_INSTALL = staleRoot;
    env.MISE_DATA_DIR = miseRoot;
    env.HOME = join(root, "home");
    env.PATH = "/definitely-not-the-caller-workspace";

    const child = Bun.spawn([sourceLauncher(), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toStartWith("Usage:");
    expect(await Bun.file(staleMarker).exists()).toBe(true);
    expect(await Bun.file(miseCwd).text()).toBe(packageRoot());
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(staleRoot, { recursive: true, force: true });
    await rm(miseRoot, { recursive: true, force: true });
  }
});

test("launcher rejects a Bun runtime below its pinned minimum", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-bun-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const bun = join(bin, "bun");
    await writeFile(bun, "#!/bin/sh\necho 1.3.9\n");
    await chmod(bun, 0o755);

    const child = Bun.spawn([sourceLauncher(), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        PI_POD_BUN_PATH: bun,
      },
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires Bun 1.3.14 or later; found 1.3.9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Crust rejects invalid input before auth, workspace, or Podman actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-invalid-"));
  try {
    const bin = join(root, "bin");
    const marker = join(root, "podman-ran");
    const state = join(root, "state");
    await mkdir(bin, { recursive: true });
    const podman = join(bin, "podman");
    await writeFile(podman, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(podman, 0o755);

    for (const argv of [
      ["run", root, "--unknown"],
      ["build", "unexpected"],
      ["login", "--agent", "pi", "--provider", "openai-codex", "--", "unexpected"],
    ]) {
      const child = Bun.spawn([sourceLauncher(), ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PI_POD_BUN_PATH: process.execPath,
          XDG_STATE_HOME: state,
        },
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Unknown flag|does not accept/);
    }
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(state, "pi-pod")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid CLI configuration fails before auth, workspace, or Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-config-"));
  try {
    const bin = join(root, "bin");
    const config = join(root, "invalid.json");
    const marker = join(root, "podman-ran");
    await mkdir(bin);
    await writeFile(config, "not json");
    await writeFile(join(bin, "podman"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, {
      mode: 0o700,
    });
    const child = Bun.spawn([sourceLauncher(), "dev", root, "--config", config], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PI_POD_BUN_PATH: process.execPath,
        PI_POD_TRUSTED_PATH: bin,
        XDG_STATE_HOME: join(root, "state"),
      },
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Configuration must be valid JSON");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit run configuration applies only the selected run preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-run-config-"));
  try {
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const config = join(root, "config.json");
    const trace = join(root, "podman-arguments");
    await mkdir(bin);
    await mkdir(workspace);
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        agents: {
          opencode: {
            dev: { preferences: { variant: "dev-only" } },
            run: {
              model: { provider: "openai", id: "fixture" },
              preferences: { variant: "high" },
            },
          },
        },
      }),
    );
    await writeFile(
      join(bin, "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    const child = Bun.spawn(
      [
        sourceLauncher(),
        "run",
        workspace,
        "--workspace",
        "bind",
        "--agent",
        "opencode",
        "--auth",
        "none",
        "--prompt",
        "fixture",
        "--config",
        config,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          PI_POD_BUN_PATH: process.execPath,
          PI_POD_TRUSTED_PATH: bin,
          XDG_STATE_HOME: join(root, "state"),
          XDG_CONFIG_HOME: join(root, "invalid"),
        },
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0);
    const argumentsUsed = await Bun.file(trace).text();
    expect(argumentsUsed).toContain("--model");
    expect(argumentsUsed).toContain("openai/fixture");
    expect(argumentsUsed).toContain("--variant");
    expect(argumentsUsed).toContain("high");
    expect(argumentsUsed).not.toContain("dev-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("dev defaults Pi to a staged host credential without mounting host Pi state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-host-auth-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const hostAgent = join(home, ".pi", "agent");
  const hostAuth = join(hostAgent, "auth.json");
  const hostSettings = join(hostAgent, "settings.json");
  const hostPackage = join(hostAgent, "packages", "host-extension-package");
  const trace = join(root, "podman-arguments");
  const source =
    '{"openai-codex":{"type":"oauth","access":"host-access","refresh":"host-refresh","expires":1900000000000}}\n';
  try {
    await mkdir(bin);
    const hostExtensions = join(hostAgent, "extensions");
    await mkdir(hostExtensions, { recursive: true });
    await mkdir(join(hostPackage, "extensions"), { recursive: true });
    await mkdir(workspace);
    await writeFile(hostAuth, source);
    await writeFile(join(hostExtensions, "fixture.ts"), "export default () => {};\n");
    await writeFile(
      join(hostPackage, "extensions", "package-fixture.ts"),
      "export default () => {};\n",
    );
    await writeFile(
      hostSettings,
      JSON.stringify({
        defaultModel: "must-not-copy",
        packages: [{ source: hostPackage, extensions: ["extensions/package-fixture.ts"] }],
      }),
    );
    await writeFile(
      join(bin, "podman"),
      `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    await chmod(join(bin, "podman"), 0o700);

    const configHome = join(root, "config");
    await mkdir(join(configHome, "pi-pod"), { recursive: true });
    await writeFile(
      join(configHome, "pi-pod", "config.json"),
      JSON.stringify({
        version: 1,
        agents: {
          pi: {
            dev: {
              model: { provider: "openai-codex", id: "configured-model" },
              preferences: { thinking: "high" },
            },
          },
        },
      }),
    );
    const child = Bun.spawn([sourceLauncher(), "dev", workspace], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PI_POD_BUN_PATH: process.execPath,
        PI_POD_TRUSTED_PATH: bin,
        HOME: home,
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: configHome,
      },
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode, stderr).toBe(0);
    expect(await Bun.file(hostAuth).text()).toBe(source);
    const argumentsUsed = await Bun.file(trace).text();
    expect(argumentsUsed).not.toContain(hostAuth);
    expect(argumentsUsed).toContain("auth-staging/");
    expect(argumentsUsed).toContain(
      `src=${hostExtensions},dst=/home/agent/.pi/agent/extensions,ro`,
    );
    expect(argumentsUsed).toContain(
      `src=${hostPackage},dst=/run/pi-pod-dev-resources/package-0,ro`,
    );
    expect(argumentsUsed).toContain("dst=/home/agent/.pi/agent/settings.json,ro,relabel=private");
    expect(argumentsUsed).not.toContain(hostSettings);
    expect(argumentsUsed).not.toContain("--no-extensions");
    expect(argumentsUsed).toContain("--provider");
    expect(argumentsUsed).toContain("openai-codex");
    expect(argumentsUsed).toContain("configured-model");
    expect(argumentsUsed).toContain("--thinking");
    expect(argumentsUsed).toContain("high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("public --no-config normalizes only wrapper arguments", () => {
  expect(normalizeConfigOptOut(["dev", ".", "--no-config", "--", "--no-config"])).toEqual([
    "dev",
    ".",
    "--skip-config",
    "--",
    "--no-config",
  ]);
});

test("Crust preserves arguments after -- for the selected agent command", async () => {
  const { root } = await app.prepareCommandTree();
  const route = resolveCommand(root, ["dev", ".", "--", "--help", "--model", "gpt-5"]);
  const parsed = parseArgs(route.command, route.argv);

  expect(route.command.meta.name).toBe("dev");
  expect(isWrapperHelpRequest(["dev", ".", "--", "--help"])).toBe(false);
  expect(parsed.rawArgs).toEqual(["--help", "--model", "gpt-5"]);
});
