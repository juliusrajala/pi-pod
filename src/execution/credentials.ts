import {
  loadAuthProfile,
  recoverHostAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostAuth,
} from "../auth/recovery.ts";
import { agentDefinition } from "../agents/registry.ts";
import type { AgentName } from "../agents/registry.ts";
import type { AuthOutcome } from "./types.ts";

export type CredentialSource = "host" | "profile";

export type StagedCredential = {
  agentStateDirectory: string;
  reconcile: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Stage a previously resolved source. Profile state is source-only and unlocked. */
export async function stageCredentialSource(input: {
  agent: AgentName;
  source: CredentialSource;
  profileName?: string;
  containerName: string;
  ownershipToken: string;
}): Promise<{ stage: StagedCredential; outcome: AuthOutcome }> {
  if (input.source === "host") {
    const hostAuth = agentDefinition(input.agent).hostAuth;
    if (hostAuth === undefined)
      throw new Error(`${input.agent} does not support host authentication.`);
    await recoverHostAuthStages(hostAuth.source);
    return {
      stage: await stageHostAuth(hostAuth.source, {
        containerName: input.containerName,
        ownershipToken: input.ownershipToken,
      }),
      outcome: { source: "host", reconciliation: "not-used", lock: "not-used" },
    };
  }
  if (input.profileName === undefined)
    throw new Error("Profile authentication requires a profile name.");
  const profile = await loadAuthProfile(input.agent, input.profileName);
  await recoverPendingAuthStages(profile);
  return {
    stage: await stageAuthProfile(profile, {
      containerName: input.containerName,
      ownershipToken: input.ownershipToken,
    }),
    outcome: { source: "profile", reconciliation: "not-used", lock: "not-used" },
  };
}
