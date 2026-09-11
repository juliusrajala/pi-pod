import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, resolveCommand } from "@crustjs/core";
import { app } from "./cli/app.ts";
import { isWrapperHelpRequest } from "./cli/help.ts";

function trustedBunPath(): string {
  return `${dirname(process.execPath)}:${process.env.PATH}`;
}

test("launcher does not load a caller workspace Bun preload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-"));
  try {
    const marker = join(root, "host-preload-ran");
    await writeFile(join(root, "bunfig.toml"), "preload = [\"./preload.ts\"]\n");
    await writeFile(join(root, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);

    const child = Bun.spawn([resolve(import.meta.dir, "..", "bin", "pi-pod"), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: trustedBunPath() },
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

test("launcher rejects a Bun runtime below its pinned minimum", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-bun-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const bun = join(bin, "bun");
    await writeFile(bun, "#!/bin/sh\necho 1.3.9\n");
    await chmod(bun, 0o755);

    const child = Bun.spawn([resolve(import.meta.dir, "..", "bin", "pi-pod"), "--help"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
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
      const child = Bun.spawn([resolve(import.meta.dir, "..", "bin", "pi-pod"), ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${bin}:${trustedBunPath()}`, XDG_STATE_HOME: state },
      });
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Unknown flag|does not accept/);
    }
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(state, "pi-pod")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev defaults Pi to a staged host credential without mounting host Pi state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pod-cli-host-auth-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const hostAgent = join(home, ".pi", "agent");
  const hostAuth = join(hostAgent, "auth.json");
  const hostSettings = join(hostAgent, "settings.json");
  const hostPackage = join(root, "host-extension-package");
  const trace = join(root, "podman-arguments");
  const source = '{"openai-codex":{"type":"oauth","access":"host-access","refresh":"host-refresh","expires":1900000000000}}\n';
  try {
    await mkdir(bin);
    const hostExtensions = join(hostAgent, "extensions");
    await mkdir(hostExtensions, { recursive: true });
    await mkdir(join(hostPackage, "extensions"), { recursive: true });
    await mkdir(workspace);
    await writeFile(hostAuth, source);
    await writeFile(join(hostExtensions, "fixture.ts"), "export default () => {};\n");
    await writeFile(join(hostPackage, "extensions", "package-fixture.ts"), "export default () => {};\n");
    await writeFile(hostSettings, JSON.stringify({
      defaultModel: "must-not-copy",
      packages: [{ source: hostPackage, extensions: ["extensions/package-fixture.ts"] }],
    }));
    await writeFile(join(bin, "podman"), `#!/bin/sh
case "$1" in
  info) printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}' ;;
  run) printf '%s\\n' "$@" > ${JSON.stringify(trace)} ;;
  container) exit 1 ;;
esac
`, { mode: 0o700 });
    await chmod(join(bin, "podman"), 0o700);

    const child = Bun.spawn([resolve(import.meta.dir, "..", "bin", "pi-pod"), "dev", workspace], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${trustedBunPath()}`,
        HOME: home,
        XDG_STATE_HOME: state,
      },
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode, stderr).toBe(0);
    expect(await Bun.file(hostAuth).text()).toBe(source);
    const argumentsUsed = await Bun.file(trace).text();
    expect(argumentsUsed).not.toContain(hostAuth);
    expect(argumentsUsed).toContain("auth-staging/");
    expect(argumentsUsed).toContain(`src=${hostExtensions},dst=/home/agent/.pi/agent/extensions,ro`);
    expect(argumentsUsed).toContain(`src=${hostPackage},dst=/run/pi-pod-dev-resources/package-0,ro`);
    expect(argumentsUsed).toContain("dst=/home/agent/.pi/agent/settings.json,ro,relabel=private");
    expect(argumentsUsed).not.toContain(hostSettings);
    expect(argumentsUsed).not.toContain("--no-extensions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("Crust preserves arguments after -- for the selected agent command", async () => {
  const { root } = await app.prepareCommandTree();
  const route = resolveCommand(root, ["dev", ".", "--", "--help", "--model", "gpt-5"]);
  const parsed = parseArgs(route.command, route.argv);

  expect(route.command.meta.name).toBe("dev");
  expect(isWrapperHelpRequest(["dev", ".", "--", "--help"])).toBe(false);
  expect(parsed.rawArgs).toEqual(["--help", "--model", "gpt-5"]);
});
