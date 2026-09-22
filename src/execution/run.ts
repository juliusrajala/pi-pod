import { stagePrompt, type PromptStage } from "./prompt.ts";
import { maxAuthStageBytes } from "../auth/staging.ts";
import { loadAuthProfile } from "../auth/profiles.ts";
import { runPodmanContainer } from "../container/lifecycle.ts";
import {
  assertDevResourceSource,
  hostPiExtensionsDirectory,
  stageHostPiExtensionPackages,
  type DevResourceStage,
} from "../agents/pi/dev-resources.ts";
import {
  assertMountSource,
  assertPodmanAvailable,
  buildPodmanRunArgs,
  podmanEnvironment,
} from "../container/args.ts";
import type {
  AuthenticationSource,
  AuthOutcome,
  RunAgentOptions,
  RunMode,
  RunResult,
} from "./types.ts";

import { assertWorkspaceWithinLimit, monitorWorkspaceUsage } from "../resources/storage.ts";
import { prepareWorkspace } from "../workspace/prepare.ts";
import { discardUnlaunchedRun, releaseRunReservation } from "../workspace/runs.ts";
import { stageCredentialSource, type StagedCredential } from "./credentials.ts";
import { resolveRunPolicy } from "./policy.ts";

export type CliRunAgentOptions = Omit<RunAgentOptions, "mode" | "auth"> & {
  mode: RunMode;
  auth: AuthenticationSource;
};

/** Public library entrypoint: headless use cannot resolve host/default policy. */
export async function runAgent(input: RunAgentOptions): Promise<RunResult> {
  return executeAgent(input, false);
}

/** Internal CLI adapter entrypoint. It is deliberately not exported from index.ts. */
export async function runCliAgent(input: CliRunAgentOptions): Promise<RunResult> {
  return executeAgent(input as RunAgentOptions, true);
}

async function executeAgent(
  input: RunAgentOptions,
  allowHeadlessHostAuth: boolean,
): Promise<RunResult> {
  const policy = resolveRunPolicy(input, { allowHeadlessHostAuth });
  const {
    agent,
    definition,
    workspaceMode,
    credentialSource,
    limits,
    image,
    timeoutMs,
    network,
    preferenceArgs,
  } = policy;
  const containerName = `pi-pod-${crypto.randomUUID().slice(0, 12)}`;
  const ownershipToken = crypto.randomUUID();
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("Agent run timed out."));
        }, timeoutMs);
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
  let launched = false;
  let authStage: StagedCredential | undefined;
  let promptStage: PromptStage | undefined;
  let devResources: DevResourceStage | undefined;
  let monitors: Array<ReturnType<typeof monitorWorkspaceUsage>> = [];
  let containerRemoved = false;
  let cleanupError: string | undefined;
  let reservation: RunResult["cleanup"]["reservation"] = "not-owned";
  let reservationError: string | undefined;
  let authOutcome: AuthOutcome = {
    source: policy.credentialSource.source,
    reconciliation: "not-used",
    lock: "not-used",
  };
  let result: RunResult | undefined;

  try {
    // Validate a named profile before workspace, host credential, or Podman side effects.
    controller.signal.throwIfAborted();
    const selectedProvider =
      credentialSource.source === "profile"
        ? (await loadAuthProfile(agent, credentialSource.profileName!)).provider
        : definition.hostAuth?.provider;
    if (selectedProvider === undefined) throw new Error(`${agent} has no selected auth provider.`);
    assertEffectiveProviderMatches(
      selectedProvider,
      agent,
      input.preferences,
      input.agentArgs ?? [],
    );
    await assertPodmanAvailable();
    workspace = await prepareWorkspace({
      path: input.workspace,
      mode: workspaceMode,
      containerName,
      ownershipToken,
      signal: controller.signal,
    });
    await assertMountSource(workspace.path);
    await assertWorkspaceWithinLimit(workspace.path, limits.workspaceBytes);

    // Stage the task only after the workspace and host preflight are valid.
    promptStage =
      input.mode === "headless" && input.prompt !== undefined
        ? await stagePrompt(input.prompt)
        : undefined;
    if (promptStage !== undefined) await assertMountSource(promptStage.file);
    const workspacePath = workspace.path;

    // resolve credential source and stage resources
    const credentials = await stageCredentialSource({
      agent,
      source: credentialSource.source,
      profileName: credentialSource.profileName,
      containerName,
      ownershipToken,
    });
    authStage = credentials.stage;
    authOutcome = credentials.outcome;
    if (authStage !== undefined) {
      await assertMountSource(authStage.agentStateDirectory);
      await assertWorkspaceWithinLimit(
        authStage.agentStateDirectory,
        maxAuthStageBytes,
        "Authentication staging",
      );
    }
    // Native passthrough follows validated preferences and therefore wins
    // without emitting a second managed preference flag.
    const agentArgs = [...preferenceArgs, ...(input.agentArgs ?? [])];
    const loadHostExtensions =
      input.mode === "interactive" &&
      definition.interactiveDevResources === "pi" &&
      !agentArgs.includes("--no-extensions");
    const extensionsDirectory = loadHostExtensions ? await hostPiExtensionsDirectory() : undefined;
    devResources = loadHostExtensions ? await stageHostPiExtensionPackages() : undefined;
    if (extensionsDirectory !== undefined) await assertMountSource(extensionsDirectory);
    if (devResources !== undefined) {
      await assertMountSource(devResources.settingsFile);
      for (const mount of devResources.mounts) {
        await assertDevResourceSource(mount.source);
        await assertMountSource(mount.source);
      }
    }

    controller.signal.throwIfAborted();
    const args = buildPodmanRunArgs({
      agent,
      mode: input.mode,
      workspace: {
        path: workspacePath,
        relabel: workspace.owned || input.relabelWorkspace === true,
      },
      authDirectory: authStage?.agentStateDirectory,
      extensionsDirectory,
      extensionSettingsFile: devResources?.settingsFile,
      extensionPackageMounts: devResources?.mounts,
      promptFile: promptStage?.file,
      agentArgs,
      environment: [],
      image,
      containerName,
      ownershipToken,
      limits,
      network,
      tty: input.mode === "interactive",
      runId: workspace.mode === "clone" ? workspace.runId : undefined,
    });

    // execute
    input.onDiagnostic?.(`${agent} in ${workspace.mode} workspace: ${workspacePath}`);
    const execution = await runPodmanContainer({
      args,
      name: containerName,
      ownershipToken,
      environment: podmanEnvironment([]),
      signal: controller.signal,
      output: input.output,
      onStarted: () => {
        launched = true;
        monitors = [
          monitorWorkspaceUsage({
            path: workspacePath,
            maxBytes: limits.workspaceBytes,
            label: "Workspace",
            controller,
            onError: input.onDiagnostic,
          }),
          ...(authStage === undefined
            ? []
            : [
                monitorWorkspaceUsage({
                  path: authStage.agentStateDirectory,
                  maxBytes: maxAuthStageBytes,
                  label: "Authentication staging",
                  controller,
                  onError: input.onDiagnostic,
                }),
              ]),
        ];
      },
      onDiagnostic: input.onDiagnostic,
    });
    containerRemoved = execution.cleanup.removed;
    cleanupError = execution.cleanup.error;
    const workspaceLimitExceeded = monitors[0]?.exceeded() ?? false;
    const authLimitExceeded = monitors[1]?.exceeded() ?? false;
    for (const monitor of monitors) monitor.stop();
    monitors = [];

    const termination = workspaceLimitExceeded
      ? "workspace-limit"
      : authLimitExceeded
        ? "auth-limit"
        : timedOut
          ? "timeout"
          : execution.aborted
            ? "aborted"
            : "exited";

    // report result; finally reconciles resources before this escapes.
    result = {
      agent,
      containerName,
      exitCode: execution.exitCode,
      termination,
      workspace,
      cleanup: {
        containerRemoved,
        reservation: workspace.owned ? "unreleased" : "not-owned",
        ...(cleanupError === undefined ? {} : { error: cleanupError }),
      },
      auth: authOutcome,
      output: {
        mode: input.output === undefined ? "inherited" : "streamed",
        ...(execution.outputError === undefined ? {} : { error: execution.outputError }),
      },
    };
    return result;
  } catch (error) {
    if (!launched && workspace?.mode === "clone") {
      const runId = workspace.runId;
      await discardUnlaunchedRun(runId, containerName, ownershipToken).catch((cleanupError) => {
        input.onDiagnostic?.(
          `Could not remove unstarted clone ${runId}: ${errorMessage(cleanupError)}`,
        );
      });
    }
    throw error;
  } finally {
    // Verify cleanup, reconcile/discard staged state, then release reservations.
    for (const monitor of monitors) monitor.stop();
    if (workspace?.mode === "clone") {
      if (containerRemoved) {
        try {
          await releaseRunReservation(workspace.runId, containerName, ownershipToken);
          reservation = "released";
        } catch (error) {
          reservation = "unreleased";
          reservationError = errorMessage(error);
          input.onDiagnostic?.(
            `Could not mark retained clone ${workspace.runId} removable: ${reservationError}`,
          );
        }
      } else {
        reservation = "unreleased";
      }
    }
    if (devResources !== undefined) {
      if (launched && !containerRemoved) {
        input.onDiagnostic?.(
          "Dev extension staging was retained because container removal was not verified.",
        );
      } else {
        await devResources.cleanup().catch((error) => {
          input.onDiagnostic?.(`Could not remove dev extension staging: ${errorMessage(error)}`);
        });
      }
    }
    if (promptStage !== undefined) {
      if (launched && !containerRemoved) {
        input.onDiagnostic?.(
          "Prompt staging was retained because container removal was not verified.",
        );
      } else {
        await promptStage.cleanup().catch((error) => {
          input.onDiagnostic?.(`Could not remove prompt staging: ${errorMessage(error)}`);
        });
      }
    }
    if (authStage !== undefined) {
      if (launched && !containerRemoved) {
        authOutcome = {
          source: authOutcome.source,
          reconciliation: "retained",
          lock: "not-used",
          error: "Container removal was not verified.",
        };
        input.onDiagnostic?.(
          "Authentication staging was retained because container removal was not verified.",
        );
      } else {
        try {
          await authStage.reconcile();
          await authStage.cleanup();
          authOutcome = { ...authOutcome, reconciliation: "not-used", lock: "not-used" };
        } catch (error) {
          const message = errorMessage(error);
          authOutcome = {
            source: authOutcome.source,
            reconciliation: "retained",
            lock: "not-used",
            error: message,
          };
          input.onDiagnostic?.(`Authentication update was retained for recovery: ${message}`);
        }
      }
    }
    if (result !== undefined) {
      result.auth = authOutcome;
      result.cleanup.reservation = reservation;
      if (reservationError !== undefined) {
        result.cleanup.error =
          result.cleanup.error === undefined
            ? reservationError
            : `${result.cleanup.error}; ${reservationError}`;
      }
    }
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function assertEffectiveProviderMatches(
  selectedProvider: string,
  agent: RunAgentOptions["agent"],
  preferences: RunAgentOptions["preferences"],
  agentArgs: readonly string[],
): void {
  const effective =
    nativeProviderOverride(agent ?? "pi", agentArgs) ?? preferences?.model?.provider;
  if (effective !== undefined && effective !== selectedProvider) {
    throw new Error(
      `Selected model provider ${effective} does not match authentication provider ${selectedProvider}.`,
    );
  }
}

/** Parse only reviewed provider-selecting native flags; unknown syntax is rejected. */
function nativeProviderOverride(
  agent: "pi" | "opencode",
  args: readonly string[],
): string | undefined {
  const flags = agent === "pi" ? ["--provider"] : ["--model", "-m"];
  let selected: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    for (const flag of flags) {
      let value: string | undefined;
      if (argument === flag) value = args[++index];
      else if (argument.startsWith(`${flag}=`)) value = argument.slice(flag.length + 1);
      else continue;
      if (value === undefined || value.length === 0)
        throw new Error(`${flag} requires a provider value when authentication is selected.`);
      if (agent === "opencode" && !value.includes("/")) {
        throw new Error(`Cannot validate provider selected by ${flag}.`);
      }
      const provider = agent === "pi" ? value : value.split("/", 1)[0];
      if (provider === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider)) {
        throw new Error(`Cannot validate provider selected by ${flag}.`);
      }
      selected = provider;
    }
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
