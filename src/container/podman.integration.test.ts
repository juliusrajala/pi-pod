import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPodmanRunArgs } from "./args.ts";
import { defaultResourceLimits } from "./image.ts";
import { hostToolEnvironment } from "../utils/process.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-pod-integration-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test.skipIf(Bun.env.PI_POD_INTEGRATION !== "1")(
  "Podman mounts workspace/auth safely and executes the bundled OpenCode binary",
  async () => {
    const workspace = join(root, "workspace");
    const authState = join(root, "auth-state");
    const promptFile = join(root, "task.txt");
    await mkdir(workspace);
    await mkdir(authState);
    await writeFile(join(authState, "auth.json"), "{}\n");
    await writeFile(promptFile, "private task text\n");
    await writeFile(join(root, "host-sentinel"), "not mounted\n");

    const args = buildPodmanRunArgs({
      agent: "pi",
      mode: "headless",
      workspace: { path: workspace, relabel: false },
      authDirectory: authState,
      promptFile,
      agentArgs: [],
      environment: [],
      image: Bun.env.PI_POD_TEST_IMAGE || "localhost/pi-pod:0.3.2",
      containerName: `pi-pod-test-${crypto.randomUUID().slice(0, 8)}`,
      limits: { ...defaultResourceLimits, temporaryBytes: 64 * 1024 * 1024 },
      network: "none",
      tty: false,
      command: [
        "bash",
        "-lc",
        'set -eu; command -v fd >/dev/null; test -n "$(opencode --version)"; touch /workspace/agent-write; test -f /home/agent/.pi/agent/auth.json; test "$(cat /run/pi-pod-prompt)" = \'private task text\'; test ! -w /run/pi-pod-prompt; test ! -e /workspace/../host-sentinel; ! touch /rootfs-write; id -u',
      ],
    });
    const proc = Bun.spawn(["podman", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: hostToolEnvironment(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe(String(process.getuid?.() ?? 1000));
    expect(await Bun.file(join(workspace, "agent-write")).exists()).toBe(true);
    expect(await Bun.file(join(root, "rootfs-write")).exists()).toBe(false);
  },
);

test.skipIf(Bun.env.PI_POD_INTEGRATION !== "1")(
  "Pi native auth storage reads a staged API-token profile without exposing its value",
  async () => {
    const provider = "synthetic-unlisted-provider";
    const authState = join(root, "auth-state");
    await mkdir(authState);
    await writeFile(
      join(authState, "auth.json"),
      `${JSON.stringify({ [provider]: { type: "api_key", key: "fixture-secret-not-output" } })}\n`,
    );
    const args = buildPodmanRunArgs({
      agent: "pi",
      mode: "headless",
      authDirectory: authState,
      agentArgs: [],
      environment: [],
      image: Bun.env.PI_POD_TEST_IMAGE || "localhost/pi-pod:0.3.2",
      containerName: `pi-pod-test-${crypto.randomUUID().slice(0, 8)}`,
      limits: { ...defaultResourceLimits, temporaryBytes: 64 * 1024 * 1024 },
      network: "none",
      tty: false,
      command: [
        "bun",
        "-e",
        `import { AuthStorage } from '/opt/pi-pod-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js'; const credential = await AuthStorage.create().read('${provider}'); if (credential?.type !== 'api_key' || credential.key !== 'fixture-secret-not-output') process.exit(17); console.log('native-auth-ok');`,
      ],
    });
    const proc = Bun.spawn(["podman", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: hostToolEnvironment(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("native-auth-ok");
    expect(stdout).not.toContain("fixture-secret-not-output");
  },
);

test.skipIf(Bun.env.PI_POD_INTEGRATION !== "1")(
  "OpenCode native auth listing reads staged API-token profiles without exposing values",
  async () => {
    const provider = "synthetic-unlisted-provider";
    const authState = join(root, "auth-state");
    await mkdir(authState);
    await writeFile(
      join(authState, "auth.json"),
      `${JSON.stringify({ [provider]: { type: "api", key: "fixture-secret-not-output" } })}\n`,
    );
    const args = buildPodmanRunArgs({
      agent: "opencode",
      mode: "headless",
      authDirectory: authState,
      agentArgs: [],
      environment: [],
      image: Bun.env.PI_POD_TEST_IMAGE || "localhost/pi-pod:0.3.2",
      containerName: `pi-pod-test-${crypto.randomUUID().slice(0, 8)}`,
      limits: { ...defaultResourceLimits, temporaryBytes: 64 * 1024 * 1024 },
      network: "none",
      tty: false,
      command: ["opencode", "auth", "list"],
    });
    const proc = Bun.spawn(["podman", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: hostToolEnvironment(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(provider);
    expect(stdout).not.toContain("fixture-secret-not-output");
  },
);

test.skipIf(Bun.env.PI_POD_INTEGRATION !== "1")(
  "Pi can update staged credentials when keep-id maps the host user to a non-1000 UID",
  async () => {
    const authState = join(root, "auth-state");
    await mkdir(authState);
    await writeFile(join(authState, "auth.json"), "{}\n");
    const args = buildPodmanRunArgs({
      agent: "pi",
      mode: "headless",
      authDirectory: authState,
      agentArgs: [],
      environment: [],
      image: Bun.env.PI_POD_TEST_IMAGE || "localhost/pi-pod:0.3.2",
      containerName: `pi-pod-test-${crypto.randomUUID().slice(0, 8)}`,
      limits: { ...defaultResourceLimits, temporaryBytes: 64 * 1024 * 1024 },
      network: "none",
      tty: false,
      command: [
        "bun",
        "-e",
        "import { AuthStorage } from '/opt/pi-pod-agent/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js'; const storage = AuthStorage.create(); await storage.modify('openai-codex', async () => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1234 }));",
      ],
    });
    args[args.indexOf("--userns=keep-id")] = "--userns=keep-id:uid=1234,gid=1234";
    args[args.indexOf("--user") + 1] = "1234:1234";
    const process = Bun.spawn(["podman", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: hostToolEnvironment(),
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const credentials = await Bun.file(join(authState, "auth.json")).json();
    expect(credentials).toEqual({
      "openai-codex": {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 1234,
      },
    });
  },
);
