import { afterEach, expect, test } from "bun:test";
import { buildPodmanRunArgs, podmanEnvironment } from "./args.ts";
import { defaultResourceLimits } from "./image.ts";

const originalOpenAi = Bun.env.OPENAI_API_KEY;
const originalGitHub = Bun.env.GITHUB_TOKEN;
const originalStripe = Bun.env.STRIPE_SECRET_KEY;
const originalTerm = Bun.env.TERM;
const originalColorTerm = Bun.env.COLORTERM;

afterEach(() => {
  if (originalOpenAi === undefined) delete Bun.env.OPENAI_API_KEY;
  else Bun.env.OPENAI_API_KEY = originalOpenAi;
  if (originalGitHub === undefined) delete Bun.env.GITHUB_TOKEN;
  else Bun.env.GITHUB_TOKEN = originalGitHub;
  if (originalStripe === undefined) delete Bun.env.STRIPE_SECRET_KEY;
  else Bun.env.STRIPE_SECRET_KEY = originalStripe;
  if (originalTerm === undefined) delete Bun.env.TERM;
  else Bun.env.TERM = originalTerm;
  if (originalColorTerm === undefined) delete Bun.env.COLORTERM;
  else Bun.env.COLORTERM = originalColorTerm;
});

test("constructs a least-privilege run with explicit mounts and environment", () => {
  Bun.env.OPENAI_API_KEY = "fake-key";
  const args = buildPodmanRunArgs({
    agent: "pi",
    mode: "headless",
    workspace: { path: "/state/runs/run-1/workspace", relabel: true },
    authDirectory: "/state/auth-stage",
    promptFile: "/state/prompt.txt",
    agentArgs: [],
    environment: ["OPENAI_API_KEY"],
    image: "localhost/pi-pod:0.1.0",
    containerName: "pi-pod-test",
    ownershipToken: "fixture-owner",
    runId: "run-1",
    limits: defaultResourceLimits,
    network: "pasta",
    tty: false,
  });

  expect(args).toContain("--userns=keep-id");
  expect(args).toContain("--cap-drop=all");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args).toContain("--read-only");
  expect(args).toContain("--http-proxy=false");
  expect(args).toContain("--image-volume=ignore");
  expect(args).toContain("--env");
  expect(args).toContain("PI_POD_CONTAINER=1");
  expect(args).toContain("OPENAI_API_KEY");
  expect(args).toContain("io.pi-pod.run-id=run-1");
  expect(args).toContain("io.pi-pod.owner=fixture-owner");
  expect(args).toContain(
    "type=bind,src=/state/runs/run-1/workspace,dst=/workspace,rw,relabel=private",
  );
  expect(args).toContain(
    "type=bind,src=/state/auth-stage,dst=/home/agent/.pi/agent,rw,relabel=private",
  );
  expect(args).toContain(
    "type=bind,src=/state/prompt.txt,dst=/run/pi-pod-prompt,ro,relabel=private",
  );
  expect(args.join(" ")).toContain("--no-context-files");
  expect(args.join(" ")).toContain("--no-approve");
  expect(args.join(" ")).not.toContain("fake-key");
  expect(args.join(" ")).not.toContain("GITHUB_TOKEN");
});

test("uses a separate writable OpenCode auth-state mount", () => {
  const args = buildPodmanRunArgs({
    agent: "opencode",
    mode: "headless",
    workspace: { path: "/workspace", relabel: false },
    authDirectory: "/state/opencode-state",
    promptFile: "/state/prompt.txt",
    agentArgs: [],
    environment: [],
    image: "image",
    containerName: "container",
    limits: defaultResourceLimits,
    network: "none",
    tty: false,
  });
  expect(args).toContain(
    "type=bind,src=/state/opencode-state,dst=/home/agent/.local/share/opencode,rw,relabel=private",
  );
  expect(args.join(" ")).toContain("exec opencode run");
  expect(args.join(" ")).toContain("--pure");
  expect(args).not.toContain("OPENCODE_DISABLE_DEFAULT_PLUGINS=true");
});

test("mounts trusted interactive Pi extensions read-only without relabeling host state", () => {
  const args = buildPodmanRunArgs({
    agent: "pi",
    mode: "interactive",
    workspace: { path: "/project", relabel: false },
    authDirectory: "/state/auth",
    extensionsDirectory: "/home/dev/.pi/agent/extensions",
    extensionSettingsFile: "/state/dev-settings.json",
    extensionPackageMounts: [
      { source: "/home/dev/pi-files", destination: "/run/pi-pod-dev-resources/package-0" },
    ],
    agentArgs: [],
    environment: [],
    image: "image",
    containerName: "container",
    limits: defaultResourceLimits,
    network: "none",
    tty: true,
  });

  expect(args).toContain(
    "type=bind,src=/home/dev/.pi/agent/extensions,dst=/home/agent/.pi/agent/extensions,ro",
  );
  expect(args).not.toContain(
    "type=bind,src=/home/dev/.pi/agent/extensions,dst=/home/agent/.pi/agent/extensions,ro,relabel=private",
  );
  expect(args).toContain(
    "type=bind,src=/state/dev-settings.json,dst=/home/agent/.pi/agent/settings.json,ro,relabel=private",
  );
  expect(args).toContain(
    "type=bind,src=/home/dev/pi-files,dst=/run/pi-pod-dev-resources/package-0,ro",
  );
  expect(args.join(" ")).not.toContain("--no-extensions");
});

test("forwards interactive terminal color capability without forwarding host credentials", () => {
  Bun.env.TERM = "xterm-256color";
  Bun.env.COLORTERM = "truecolor";
  const args = buildPodmanRunArgs({
    agent: "pi",
    mode: "interactive",
    workspace: { path: "/project", relabel: false },
    agentArgs: [],
    environment: [],
    image: "image",
    containerName: "container",
    limits: defaultResourceLimits,
    network: "none",
    tty: true,
  });

  expect(args).toContain("TERM=xterm-256color");
  expect(args).toContain("COLORTERM=truecolor");
});

test("does not relabel a caller-owned bind workspace without explicit consent", () => {
  const args = buildPodmanRunArgs({
    agent: "pi",
    mode: "interactive",
    workspace: { path: "/project", relabel: false },
    agentArgs: [],
    environment: [],
    image: "image",
    containerName: "container",
    limits: defaultResourceLimits,
    network: "none",
    tty: true,
  });
  expect(args).toContain("type=bind,src=/project,dst=/workspace,rw");
  expect(args).not.toContain("type=bind,src=/project,dst=/workspace,rw,relabel=private");
});

test("forwards only explicitly named API credentials to the Podman client", () => {
  Bun.env.OPENAI_API_KEY = "fake-explicit-api-key";
  Bun.env.STRIPE_SECRET_KEY = "fake-unrelated-secret";

  const named = podmanEnvironment(["OPENAI_API_KEY"]);
  const unnamed = podmanEnvironment([]);
  const args = buildPodmanRunArgs({
    agent: "pi",
    mode: "headless",
    workspace: { path: "/workspace", relabel: false },
    agentArgs: [],
    environment: ["OPENAI_API_KEY"],
    image: "image",
    containerName: "container",
    limits: defaultResourceLimits,
    network: "none",
    tty: false,
  });

  expect(named.OPENAI_API_KEY).toBe("fake-explicit-api-key");
  expect(named.STRIPE_SECRET_KEY).toBeUndefined();
  expect(unnamed.OPENAI_API_KEY).toBeUndefined();
  expect(args).toContain("OPENAI_API_KEY");
  expect(args.join(" ")).not.toContain("fake-explicit-api-key");
});

test("rejects forge, SSH, database, proxy, and unrelated credential names", () => {
  const forbidden = [
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "DATABASE_URL",
    "HTTPS_PROXY",
    "STRIPE_SECRET_KEY",
  ];
  for (const name of forbidden) {
    expect(() => podmanEnvironment([name])).toThrow("never forwarded");
    expect(() =>
      buildPodmanRunArgs({
        agent: "pi",
        mode: "headless",
        workspace: { path: "/workspace", relabel: false },
        agentArgs: [],
        environment: [name],
        image: "image",
        containerName: "container",
        limits: defaultResourceLimits,
        network: "none",
        tty: false,
      }),
    ).toThrow("never forwarded");
  }
});
