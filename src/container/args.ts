import { stat } from "node:fs/promises";
import { agentDefinition } from "../agents/registry.ts";
import { piPodVersion } from "./image.ts";
import type { AgentName, ResourceLimits, RunMode } from "../execution/types.ts";
import { commandOutput, hostToolEnvironment } from "../utils/process.ts";
import { assertSafeMountPath } from "../state/identifiers.ts";

const forbiddenEnvironment = new Set([
  // Forge and source-control credentials.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "GIT_ASKPASS",
  // Host identity and database credentials.
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGPASSWORD",
  "MYSQL_PWD",
  "REDIS_URL",
  // Proxies can route a task through host-only credential infrastructure.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // Other ambient service/cloud credentials are not task API credentials.
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "SLACK_TOKEN",
  "NPM_TOKEN",
]);

export type PodmanLaunchOptions = {
  agent: AgentName;
  mode: RunMode;
  workspace?: { path: string; relabel: boolean };
  authDirectory?: string;
  /** Developer-trusted global Pi extensions, mounted only for interactive dev. */
  extensionsDirectory?: string;
  /** Filtered wrapper-owned Pi settings containing local extension packages only. */
  extensionSettingsFile?: string;
  /** Read-only local package roots referenced by extensionSettingsFile. */
  extensionPackageMounts?: readonly { source: string; destination: string }[];
  /** Wrapper-owned host file mounted read-only at a fixed agent path. */
  promptFile?: string;
  agentArgs: readonly string[];
  environment: readonly string[];
  image: string;
  containerName: string;
  /** Per-launch nonce used to prove ownership before cleanup/recovery. */
  ownershipToken?: string;
  limits: ResourceLimits;
  network: "pasta" | "none";
  tty: boolean;
  runId?: string;
  command?: readonly string[];
};

export function buildPodmanRunArgs(options: PodmanLaunchOptions): string[] {
  const agent = agentDefinition(options.agent);
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const workspaceMount =
    options.workspace === undefined
      ? []
      : bindMount(options.workspace.path, "/workspace", options.workspace.relabel);
  const authMount =
    options.authDirectory === undefined
      ? []
      : bindMount(options.authDirectory, agent.authDirectory, true);
  const extensionMount =
    options.extensionsDirectory === undefined
      ? []
      : bindMount(options.extensionsDirectory, `${agent.authDirectory}/extensions`, false, false);
  const extensionSettingsMount =
    options.extensionSettingsFile === undefined
      ? []
      : bindMount(
          options.extensionSettingsFile,
          `${agent.authDirectory}/settings.json`,
          true,
          false,
        );
  const extensionPackageMounts = (options.extensionPackageMounts ?? []).flatMap(
    ({ source, destination }) => bindMount(source, destination, false, false),
  );
  const promptMount =
    options.promptFile === undefined
      ? []
      : bindMount(options.promptFile, "/run/pi-pod-prompt", true, false);
  const environment = forwardedEnvironment(options.environment);
  const terminalEnvironment = options.tty
    ? ["TERM", "COLORTERM"].flatMap((name) =>
        Bun.env[name] === undefined ? [] : ["--env", `${name}=${Bun.env[name]}`],
      )
    : [];
  const command =
    options.command ??
    agent.command({
      mode: options.mode,
      promptPath: options.promptFile === undefined ? undefined : "/run/pi-pod-prompt",
      agentArgs: options.agentArgs,
    });

  return [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    options.containerName,
    "--label",
    "io.pi-pod.managed=true",
    "--label",
    `io.pi-pod.version=${piPodVersion}`,
    ...(options.ownershipToken === undefined
      ? []
      : ["--label", `io.pi-pod.owner=${options.ownershipToken}`]),
    ...(options.runId === undefined ? [] : ["--label", `io.pi-pod.run-id=${options.runId}`]),
    "--userns=keep-id",
    "--user",
    user,
    "--init",
    "--network",
    options.network,
    "--http-proxy=false",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--read-only-tmpfs=false",
    "--image-volume=ignore",
    "--memory",
    options.limits.memory,
    "--cpus",
    String(options.limits.cpus),
    "--pids-limit",
    String(options.limits.pids),
    "--ulimit",
    `fsize=${options.limits.workspaceBytes}:${options.limits.workspaceBytes}`,
    "--shm-size",
    "64m",
    "--tmpfs",
    `/tmp:rw,size=${options.limits.temporaryBytes},mode=1777`,
    "--tmpfs",
    `/home/agent:rw,size=${options.limits.temporaryBytes},mode=1777`,
    ...workspaceMount,
    ...authMount,
    ...extensionMount,
    ...extensionSettingsMount,
    ...extensionPackageMounts,
    ...promptMount,
    "--workdir",
    "/workspace",
    ...Object.entries(agent.environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    ...terminalEnvironment,
    ...environment.flatMap((name) => ["--env", name]),
    ...(options.tty ? ["--interactive", "--tty"] : []),
    options.image,
    ...command,
  ];
}

export function podmanEnvironment(names: readonly string[]): Record<string, string> {
  const sanitized = hostToolEnvironment(names);
  for (const name of names) {
    validateForwardedEnvironment(name);
    const value = Bun.env[name];
    if (value === undefined) throw new Error(`Environment variable ${name} is not set.`);
    sanitized[name] = value;
  }
  return sanitized;
}

export async function assertPodmanAvailable(): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("pi-pod requires native Linux with local rootless Podman.");
  const info = await podmanInfo();
  if (
    !isRecord(info) ||
    !isRecord(info.host) ||
    !isRecord(info.host.security) ||
    info.host.security.rootless !== true
  ) {
    throw new Error("pi-pod requires local rootless Podman.");
  }
  const host = info.host;
  if (host.os !== "linux" || host.cgroupVersion !== "v2") {
    throw new Error("pi-pod requires local Linux Podman with cgroup v2 resource enforcement.");
  }
  const cgroupControllers = host.cgroupControllers;
  if (
    !Array.isArray(cgroupControllers) ||
    !["cpu", "memory", "pids"].every((controller) => cgroupControllers.includes(controller))
  ) {
    throw new Error(
      "Podman lacks the cpu, memory, or pids cgroup controller required for pi-pod limits.",
    );
  }
  if (host.serviceIsRemote === true) {
    throw new Error("pi-pod does not support remote Podman services.");
  }
}

/** Whether a rootless local Podman session only needs a delegated cgroup scope. */
export async function podmanNeedsDelegatedScope(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const info = await podmanInfo();
    if (!isRecord(info) || !isRecord(info.host)) return false;
    const host = info.host;
    const security = host.security;
    if (!isRecord(security)) return false;
    if (
      host.os !== "linux" ||
      host.cgroupVersion !== "v2" ||
      security.rootless !== true ||
      host.serviceIsRemote === true
    ) {
      return false;
    }
    const controllers = host.cgroupControllers;
    return (
      Array.isArray(controllers) &&
      !["cpu", "memory", "pids"].every((controller) => controllers.includes(controller))
    );
  } catch {
    // Preserve the normal, specific preflight error when Podman itself is not usable.
    return false;
  }
}

async function podmanInfo(): Promise<unknown> {
  const raw = await commandOutput(["podman", "info", "--format", "json"], {
    env: hostToolEnvironment(),
  });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Podman returned invalid info JSON.");
  }
}

export async function assertMountSource(path: string): Promise<void> {
  assertSafeMountPath(path);
  await stat(path);
}

function bindMount(
  source: string,
  destination: string,
  relabel: boolean,
  writable = true,
): string[] {
  assertSafeMountPath(source);
  const options = ["type=bind", `src=${source}`, `dst=${destination}`, writable ? "rw" : "ro"];
  if (relabel) options.push("relabel=private");
  return ["--mount", options.join(",")];
}

function forwardedEnvironment(names: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    validateForwardedEnvironment(name);
    if (Bun.env[name] === undefined) throw new Error(`Environment variable ${name} is not set.`);
    seen.add(name);
  }
  return [...seen];
}

function validateForwardedEnvironment(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid environment variable name: ${name}`);
  if (forbiddenEnvironment.has(name))
    throw new Error(`${name} is never forwarded into agent containers.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
