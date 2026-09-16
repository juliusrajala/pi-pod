import { loginCommand, loginInstructions } from "./agents.ts";
import { resolvedResourceLimits, resolvedTimeoutMs } from "./options.ts";
import { stagePrompt, type PromptStage } from "./prompt.ts";
import { maxAuthStageBytes } from "./auth/staging.ts";
import { runPodmanContainer } from "./container/lifecycle.ts";
import {
  acquireAuthProfile,
  createAuthProfile,
  recoverPendingAuthStages,
  stageAuthProfile,
} from "./auth.ts";
import {
  assertDevResourceSource,
  hostPiExtensionsDirectory,
  stageHostPiExtensionPackages,
  type DevResourceStage,
} from "./dev-resources.ts";
import { assertMountSource, assertPodmanAvailable, buildPodmanRunArgs, podmanEnvironment } from "./podman.ts";
import type { AgentName, AuthOutcome, LoginOptions, LoginResult, RunAgentOptions, RunResult } from "./types.ts";
import { agents, defaultResourceLimits } from "./types.ts";
import { commandOutput, hostToolEnvironment } from "./utils/process.ts";
import { validIdentifier } from "./utils.ts";
import { assertWorkspaceWithinLimit, monitorWorkspaceUsage } from "./workspace-usage.ts";
import { discardUnlaunchedRun, prepareWorkspace, releaseRunReservation, removeRun } from "./workspace.ts";
import { resolveCredentialSource, stageCredentialSource, type StagedCredential } from "./run/credentials.ts";

const defaultImage = "localhost/pi-pod:0.1.0";
const headlessTimeoutMs = 10 * 60 * 1_000;

export async function runAgent(input: RunAgentOptions): Promise<RunResult> {
  const agent = input.agent ?? "pi";
  assertAgent(agent);
  const workspaceMode = input.workspaceMode ?? (input.mode === "interactive" ? "bind" : "clone");
  const credentialSource = resolveCredentialSource({ agent, mode: input.mode, authProfile: input.authProfile });
  const limits = resolvedResourceLimits(input.limits);
  const image = input.image?.trim() || defaultImage;
  const containerName = `pi-pod-${crypto.randomUUID().slice(0, 12)}`;
  const controller = new AbortController();
  const timeoutMs = resolvedTimeoutMs(input.mode, input.timeoutMs, headlessTimeoutMs);
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let timedOut = false;
  const timeout = timeoutMs === undefined
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
  let releaseAuth: (() => Promise<void>) | undefined;
  let monitors: Array<ReturnType<typeof monitorWorkspaceUsage>> = [];
  let containerRemoved = false;
  let cleanupError: string | undefined;
  let retainAuthProfile = false;
  let reservation: RunResult["cleanup"]["reservation"] = "not-owned";
  let reservationError: string | undefined;
  let authOutcome: AuthOutcome = { source: "none", reconciliation: "not-used", lock: "not-used" };
  let result: RunResult | undefined;

  try {
    // prepare workspace
    controller.signal.throwIfAborted();
    await assertPodmanAvailable();
    workspace = await prepareWorkspace({
      path: input.workspace,
      mode: workspaceMode,
      containerName,
      signal: controller.signal,
    });
    await assertMountSource(workspace.path);
    await assertWorkspaceWithinLimit(workspace.path, limits.workspaceBytes);

    // Stage the task only after the workspace and host preflight are valid.
    promptStage = input.mode === "headless" && input.prompt !== undefined
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
      onProfileLock: (release) => { releaseAuth = release; },
    });
    authStage = credentials.stage;
    releaseAuth = credentials.release;
    authOutcome = credentials.outcome;
    if (authStage !== undefined) {
      await assertMountSource(authStage.agentStateDirectory);
      await assertWorkspaceWithinLimit(authStage.agentStateDirectory, maxAuthStageBytes, "Authentication staging");
    }
    const agentArgs = input.agentArgs ?? [];
    const loadHostExtensions = input.mode === "interactive" && agent === "pi" && !agentArgs.includes("--no-extensions");
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
      workspace: { path: workspacePath, relabel: workspace.owned || input.relabelWorkspace === true },
      authDirectory: authStage?.agentStateDirectory,
      extensionsDirectory,
      extensionSettingsFile: devResources?.settingsFile,
      extensionPackageMounts: devResources?.mounts,
      promptFile: promptStage?.file,
      agentArgs,
      environment: input.environment ?? [],
      image,
      containerName,
      limits,
      network: input.network ?? "pasta",
      tty: input.mode === "interactive",
      runId: workspace.runId,
    });

    // execute
    input.onDiagnostic?.(`${agent} in ${workspace.mode} workspace: ${workspacePath}`);
    const execution = await runPodmanContainer({
      args,
      name: containerName,
      environment: podmanEnvironment(input.environment ?? []),
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
          ...(authStage === undefined ? [] : [monitorWorkspaceUsage({
            path: authStage.agentStateDirectory,
            maxBytes: maxAuthStageBytes,
            label: "Authentication staging",
            controller,
            onError: input.onDiagnostic,
          })]),
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
    if (!launched && workspace?.owned && workspace.runId !== undefined) {
      await discardUnlaunchedRun(workspace.runId, containerName).catch((cleanupError) => {
        input.onDiagnostic?.(`Could not remove unstarted clone ${workspace!.runId}: ${errorMessage(cleanupError)}`);
      });
    }
    throw error;
  } finally {
    // Verify cleanup, reconcile/discard staged state, then release reservations.
    for (const monitor of monitors) monitor.stop();
    if (workspace?.owned && workspace.runId !== undefined) {
      if (containerRemoved) {
        try {
          await releaseRunReservation(workspace.runId, containerName);
          reservation = "released";
        } catch (error) {
          reservation = "unreleased";
          reservationError = errorMessage(error);
          input.onDiagnostic?.(`Could not mark retained clone ${workspace.runId} removable: ${reservationError}`);
        }
      } else {
        reservation = "unreleased";
      }
    }
    if (devResources !== undefined) {
      if (launched && !containerRemoved) {
        input.onDiagnostic?.("Dev extension staging was retained because container removal was not verified.");
      } else {
        await devResources.cleanup().catch((error) => {
          input.onDiagnostic?.(`Could not remove dev extension staging: ${errorMessage(error)}`);
        });
      }
    }
    if (promptStage !== undefined) {
      if (launched && !containerRemoved) {
        input.onDiagnostic?.("Prompt staging was retained because container removal was not verified.");
      } else {
        await promptStage.cleanup().catch((error) => {
          input.onDiagnostic?.(`Could not remove prompt staging: ${errorMessage(error)}`);
        });
      }
    }
    if (authStage !== undefined) {
      if (launched && !containerRemoved) {
        retainAuthProfile = authOutcome.source === "profile";
        authOutcome = {
          source: authOutcome.source,
          reconciliation: "retained",
          lock: authOutcome.source === "profile" ? "retained" : "not-used",
          error: "Container removal was not verified.",
        };
        input.onDiagnostic?.("Authentication staging was retained because container removal was not verified.");
      } else {
        try {
          await authStage.reconcile();
          await authStage.cleanup();
          authOutcome = authOutcome.source === "profile"
            ? { source: "profile", reconciliation: "persisted", lock: "retained" }
            : { source: "host", reconciliation: "not-used", lock: "not-used" };
        } catch (error) {
          const message = errorMessage(error);
          authOutcome = {
            source: authOutcome.source,
            reconciliation: "retained",
            lock: authOutcome.source === "profile" ? "retained" : "not-used",
            error: message,
          };
          input.onDiagnostic?.(`Authentication update was retained for recovery: ${message}`);
        }
      }
    }
    if (!retainAuthProfile && releaseAuth !== undefined) {
      try {
        await releaseAuth();
        if (authOutcome.lock !== "not-used") authOutcome = { ...authOutcome, lock: "released" };
      } catch (error) {
        const message = errorMessage(error);
        authOutcome = { ...authOutcome, lock: "release-failed", error: message };
        input.onDiagnostic?.(`Could not release authentication profile: ${message}`);
      }
    }
    if (result !== undefined) {
      result.auth = authOutcome;
      result.cleanup.reservation = reservation;
      if (reservationError !== undefined) {
        result.cleanup.error = result.cleanup.error === undefined
          ? reservationError
          : `${result.cleanup.error}; ${reservationError}`;
      }
    }
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function removeAgentRun(runId: string): Promise<void> {
  validIdentifier(runId, "Run ID");
  const active = await commandOutput([
    "podman",
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=io.pi-pod.run-id=${runId}`,
  ], { env: hostToolEnvironment() });
  if (active.trim().length > 0) {
    throw new Error(`Run ${runId} still has a container. Stop it before removing its workspace.`);
  }
  await removeRun(runId);
}

export async function login(input: LoginOptions): Promise<LoginResult> {
  assertAgent(input.agent);
  input.signal?.throwIfAborted();
  const profileName = input.profile ?? "default";
  const provider = input.provider.trim();
  const containerName = `pi-pod-login-${crypto.randomUUID().slice(0, 12)}`;
  const profile = await createAuthProfile({ agent: input.agent, name: profileName, provider });
  const lock = await acquireAuthProfile(profile, { containerName });
  let stage: Awaited<ReturnType<typeof stageAuthProfile>> | undefined;
  let retainProfileLock = false;
  try {
    await recoverPendingAuthStages(profile);
    await assertPodmanAvailable();
    stage = await stageAuthProfile(profile, { containerName });
    input.onDiagnostic?.(loginInstructions(input.agent, provider));
    const args = buildPodmanRunArgs({
      agent: input.agent,
      mode: "interactive",
      authDirectory: stage.agentStateDirectory,
      agentArgs: [],
      environment: [],
      image: input.image?.trim() || defaultImage,
      containerName,
      limits: defaultResourceLimits,
      network: "pasta",
      tty: true,
      command: loginCommand(input.agent, provider),
    });
    const execution = await runPodmanContainer({
      args,
      name: containerName,
      environment: podmanEnvironment([]),
      signal: input.signal,
      output: input.output,
      onDiagnostic: input.onDiagnostic,
    });
    if (!execution.cleanup.removed) {
      retainProfileLock = true;
      throw new Error(`Could not verify removal of login container ${containerName}: ${execution.cleanup.error ?? "unknown cleanup failure"}`);
    }
    if (execution.aborted) throw new DOMException("Login aborted.", "AbortError");
    if (execution.exitCode !== 0) throw new Error(`${input.agent} login exited with status ${execution.exitCode}.`);
    await stage.reconcile();
    await stage.cleanup();
    stage = undefined;
    return { agent: input.agent, provider, profile: profileName };
  } finally {
    if (stage !== undefined) {
      // A failed or interrupted login may contain a newer rotating token. Keep
      // the isolated file rather than overwriting the known-good profile.
      input.onDiagnostic?.("Login credential staging was retained for recovery.");
    }
    if (!retainProfileLock) await lock.release();
  }
}

function assertAgent(agent: string): asserts agent is AgentName {
  if (!(agents as readonly string[]).includes(agent)) throw new Error(`Unsupported agent: ${agent}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
