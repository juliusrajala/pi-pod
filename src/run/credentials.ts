import {
  acquireAuthProfile,
  loadAuthProfile,
  recoverHostAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostOpenCodeAuth,
  stageHostPiAuth,
} from "../auth.ts";
import type { AgentName, AuthOutcome, RunMode } from "../types.ts";

export type CredentialSource = "host" | "profile" | "none";

export type StagedCredential = {
  agentStateDirectory: string;
  reconcile: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Validate the credential policy before workspace, state, or Podman side effects. */
export function resolveCredentialSource(input: {
  agent: AgentName;
  mode: RunMode;
  authProfile?: string | "none";
}): { source: CredentialSource; profileName?: string } {
  const requested = input.authProfile ?? (input.mode === "interactive" ? "host" : "default");
  if (requested === "host") {
    if (input.mode !== "interactive") {
      throw new Error("Host credentials are available only to interactive dev sessions.");
    }
    return { source: "host" };
  }
  return requested === "none" ? { source: "none" } : { source: "profile", profileName: requested };
}

/** Acquire, recover, and stage the explicitly selected wrapper-owned source. */
export async function stageCredentialSource(input: {
  agent: AgentName;
  source: CredentialSource;
  profileName?: string;
  containerName: string;
  /** Register immediately so failed stage recovery still releases the lock. */
  onProfileLock?: (release: () => Promise<void>) => void;
}): Promise<{
  stage?: StagedCredential;
  release?: () => Promise<void>;
  outcome: AuthOutcome;
}> {
  if (input.source === "none") {
    return { outcome: { source: "none", reconciliation: "not-used", lock: "not-used" } };
  }
  if (input.source === "host") {
    await recoverHostAuthStages(input.agent === "pi" ? "host-pi" : "host-opencode");
    return {
      stage: input.agent === "pi"
        ? await stageHostPiAuth({ containerName: input.containerName })
        : await stageHostOpenCodeAuth({ containerName: input.containerName }),
      outcome: { source: "host", reconciliation: "not-used", lock: "not-used" },
    };
  }
  const profile = await loadAuthProfile(input.agent, input.profileName!);
  const lock = await acquireAuthProfile(profile, { containerName: input.containerName });
  input.onProfileLock?.(lock.release);
  await recoverPendingAuthStages(profile);
  return {
    stage: await stageAuthProfile(profile, { containerName: input.containerName }),
    release: lock.release,
    outcome: { source: "profile", reconciliation: "retained", lock: "retained" },
  };
}
