import { Crust } from "@crustjs/core";
import { resolve } from "node:path";
import { loadCliConfiguration } from "../../config/load.ts";
import { maxPromptBytes } from "../../execution/prompt.ts";
import { loadCliAuthDefault } from "../../auth/defaults.ts";
import { loadAuthProfile } from "../../auth/profiles.ts";
import { runCliAgent } from "../../execution/run.ts";
import { resolveRunPolicy } from "../../execution/policy.ts";
import { validIdentifier } from "../../state/identifiers.ts";
import {
  agents,
  workspaceModes,
  type AgentName,
  type ResourceLimits,
  type RunMode,
  type RunResult,
  type WorkspaceMode,
} from "../../execution/types.ts";
import { readBoundedText } from "../../utils/fs.ts";
import { reexecInDelegatedScope } from "../delegation.ts";
import { interruptSignal } from "../signals.ts";
import { requireNoExtraArguments } from "./validation.ts";

const commonAgentFlags = {
  agent: { type: "string", choices: agents },
  workspace: { type: "string", choices: workspaceModes },
  auth: { type: "string" },
  image: { type: "string" },
  network: { type: "string", choices: ["pasta", "none"] as const },
  "relabel-workspace": { type: "boolean" },
  memory: { type: "string" },
  cpus: { type: "number" },
  pids: { type: "number" },
  "workspace-bytes": { type: "number" },
  "temporary-bytes": { type: "number" },
  config: { type: "string" },
} as const;

type CommonAgentFlags = {
  agent?: string;
  workspace?: string;
  auth?: string;
  image?: string;
  network?: string;
  "relabel-workspace"?: boolean;
  memory?: string;
  cpus?: number;
  pids?: number;
  "workspace-bytes"?: number;
  "temporary-bytes"?: number;
  config?: string;
  "skip-config"?: boolean;
};

export const devCommand = new Crust("dev")
  .meta({ description: "Start an interactive agent in a workspace" })
  .args([
    { name: "directory", type: "path", required: true },
    { name: "arguments", type: "string", variadic: true },
  ] as const)
  .flags({
    ...commonAgentFlags,
    "skip-config": { type: "boolean" },
  } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "dev");
    await launchAgent({
      mode: "interactive",
      workspace: args.directory,
      flags,
      agentArgs: rawArgs,
    });
  });

export const runCommand = new Crust("run")
  .meta({ description: "Run an agent headlessly in an isolated clone" })
  .args([
    { name: "directory", type: "path", required: true },
    { name: "arguments", type: "string", variadic: true },
  ] as const)
  .flags({
    ...commonAgentFlags,
    prompt: { type: "string" },
    "prompt-file": { type: "path" },
    timeout: { type: "number" },
  } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "run");
    await launchAgent({
      mode: "headless",
      workspace: args.directory,
      flags,
      agentArgs: rawArgs,
      prompt: await readPrompt(flags.prompt, flags["prompt-file"]),
      timeoutMs: timeoutMilliseconds(flags.timeout),
    });
  });

async function launchAgent(input: {
  mode: RunMode;
  workspace: string;
  flags: CommonAgentFlags;
  agentArgs: readonly string[];
  prompt?: string;
  timeoutMs?: number;
}): Promise<void> {
  // Configuration must fail before delegation, workspace/auth preparation, or Podman.
  const configuration = await loadCliConfiguration({
    mode: input.mode,
    agent: (input.flags.agent as AgentName | undefined) ?? "pi",
    configPath: input.flags.config,
    noConfig: input.flags["skip-config"] === true,
  });
  const preferences = configuration?.preferences;
  // Keep caller-controlled validation pure: do not create/read auth state or
  // credentials until limits, network, model preferences, and syntax pass.
  validateCliAuthSyntax(input.flags.auth);
  resolveRunPolicy(
    {
      agent: input.flags.agent as AgentName | undefined,
      mode: input.mode,
      workspace: input.workspace,
      workspaceMode: input.flags.workspace as WorkspaceMode | undefined,
      prompt: input.prompt,
      preferences,
      agentArgs: input.agentArgs,
      auth: { type: "host" },
      image: input.flags.image,
      limits: resourceLimits(input.flags),
      timeoutMs: input.timeoutMs,
      network: input.flags.network as "pasta" | "none" | undefined,
      relabelWorkspace: input.flags["relabel-workspace"] === true,
    } as never,
    { allowHeadlessHostAuth: true },
  );
  if (await reexecInDelegatedScope(process.argv.slice(2))) return;
  const interrupt = interruptSignal();
  try {
    const result = await runCliAgent({
      agent: input.flags.agent as AgentName | undefined,
      mode: input.mode,
      workspace: input.workspace,
      workspaceMode: input.flags.workspace as WorkspaceMode | undefined,
      prompt: input.prompt,
      preferences,
      packages: configuration?.packages,
      agentArgs: input.agentArgs,
      auth: await resolveCliAuth(
        (input.flags.agent as AgentName | undefined) ?? "pi",
        input.flags.auth,
      ),
      image: input.flags.image,
      limits: resourceLimits(input.flags),
      timeoutMs: input.timeoutMs,
      network: input.flags.network as "pasta" | "none" | undefined,
      relabelWorkspace: input.flags["relabel-workspace"] === true,
      signal: interrupt.signal,
      onDiagnostic: (message) => console.error(`pi-pod: ${message}`),
    });
    reportRunResult(result);
  } finally {
    interrupt.dispose();
  }
}

function resourceLimits(flags: CommonAgentFlags): Partial<ResourceLimits> {
  return {
    ...(flags.memory === undefined ? {} : { memory: flags.memory }),
    ...(flags.cpus === undefined ? {} : { cpus: flags.cpus }),
    ...(flags.pids === undefined ? {} : { pids: flags.pids }),
    ...(flags["workspace-bytes"] === undefined ? {} : { workspaceBytes: flags["workspace-bytes"] }),
    ...(flags["temporary-bytes"] === undefined ? {} : { temporaryBytes: flags["temporary-bytes"] }),
  };
}

function validateCliAuthSyntax(requested: string | undefined): void {
  if (requested === undefined || requested === "host") return;
  if (requested === "none") throw new Error('"none" is not an authentication source.');
  validIdentifier(requested, "Auth profile");
}

async function resolveCliAuth(
  agent: AgentName,
  requested: string | undefined,
): Promise<{ type: "host" } | { type: "profile"; name: string }> {
  if (requested === undefined) {
    const selected = await loadCliAuthDefault(agent);
    return selected === "host" ? { type: "host" } : selected;
  }
  if (requested === "host") return { type: "host" };
  if (requested === "none") throw new Error('"none" is not an authentication source.');
  if (!requested) throw new Error("--auth requires host or a profile name.");
  // Validate ownership/version before delegation, workspace, or Podman work.
  await loadAuthProfile(agent, requested);
  return { type: "profile", name: requested };
}

async function readPrompt(
  prompt: string | undefined,
  promptFile: string | undefined,
): Promise<string> {
  if (prompt !== undefined && promptFile !== undefined)
    throw new Error("Use either --prompt or --prompt-file, not both.");
  if (prompt !== undefined) return prompt;
  if (promptFile === undefined) throw new Error("run requires --prompt or --prompt-file.");
  try {
    return await readBoundedText(resolve(promptFile), maxPromptBytes);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }
    throw error;
  }
}

function timeoutMilliseconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("--timeout must be a positive number of seconds.");
  return seconds * 1_000;
}

function reportRunResult(result: RunResult): void {
  if (result.workspace.owned)
    console.error(`Retained clone ${result.workspace.runId}: ${result.workspace.path}`);
  if (!result.cleanup.containerRemoved || result.cleanup.reservation === "unreleased") {
    console.error(
      `Container or retained-clone cleanup was not verified: ${result.cleanup.error ?? result.containerName}`,
    );
    process.exitCode = 1;
    return;
  }
  const authRequiresRecovery = result.auth.reconciliation === "retained";
  if (authRequiresRecovery) {
    console.error(
      `Authentication persistence requires recovery: ${result.auth.error ?? result.auth.lock}.`,
    );
  }
  if (result.termination === "exited") {
    process.exitCode = authRequiresRecovery && result.exitCode === 0 ? 1 : result.exitCode;
    return;
  }
  console.error(`Agent ${result.termination}.`);
  process.exitCode =
    result.termination === "timeout" ? 124 : result.termination === "aborted" ? 130 : 1;
}
