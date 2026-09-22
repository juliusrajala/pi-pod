import type { AgentName } from "../agents/registry.ts";
import { loadAuthProfile, type AuthProfile } from "./profiles.ts";
import {
  discardPendingAuthStages as discardStages,
  recoverHostAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostAuth,
  type AuthStage,
  type HostAuthStage,
} from "./staging.ts";

export type { AuthProfile, AuthStage, HostAuthStage };
export {
  loadAuthProfile,
  recoverHostAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostAuth,
};

/** Discard interrupted source-only API-token stages after exact container checks. */
export async function discardPendingAuthStages(agent: AgentName, name: string): Promise<void> {
  await discardStages(await loadAuthProfile(agent, name));
}
