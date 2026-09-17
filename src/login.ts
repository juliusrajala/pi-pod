import { agentDefinition, assertAgentMode } from "./agents/registry.ts";
import { defaultImage, defaultResourceLimits } from "./defaults.ts";
import {
  acquireAuthProfile,
  createAuthProfile,
  recoverPendingAuthStages,
  stageAuthProfile,
} from "./auth.ts";
import { runPodmanContainer } from "./container/lifecycle.ts";
import { assertPodmanAvailable, buildPodmanRunArgs, podmanEnvironment } from "./podman.ts";
import type { LoginOptions, LoginResult } from "./types.ts";

/** Profile-login orchestration shares the same hardened lifecycle as a run. */
export async function login(input: LoginOptions): Promise<LoginResult> {
  const definition = agentDefinition(input.agent);
  assertAgentMode(definition, "interactive");
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
    input.onDiagnostic?.(definition.loginInstructions(provider));
    const execution = await runPodmanContainer({
      args: buildPodmanRunArgs({
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
        command: definition.loginCommand(provider),
      }),
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
      // A failed/interrupted native writer may hold a newer rotating token.
      input.onDiagnostic?.("Login credential staging was retained for recovery.");
    }
    if (!retainProfileLock) await lock.release();
  }
}
