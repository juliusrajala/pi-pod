import type { AgentName } from "./types.ts";
import {
  acquireAuthProfile,
  removeAuthProfileLock as removeProfileLock,
  type ProfileLock,
} from "./auth/lock.ts";
import {
  createAuthProfile,
  loadAuthProfile,
  type AuthProfile,
} from "./auth/profiles.ts";
import {
  discardPendingAuthStages as discardStages,
  recoverHostPiAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostPiAuth,
  type AuthStage,
  type HostAuthStage,
} from "./auth/staging.ts";

export type { AuthProfile, AuthStage, HostAuthStage, ProfileLock };
export {
  acquireAuthProfile,
  createAuthProfile,
  loadAuthProfile,
  recoverHostPiAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostPiAuth,
};

/** Recover interrupted stages while holding the same exclusive profile lock as a live agent. */
export async function recoverAuthProfile(agent: AgentName, name: string): Promise<void> {
  const profile = await loadAuthProfile(agent, name);
  const lock = await acquireAuthProfile(profile);
  try {
    await recoverPendingAuthStages(profile);
  } finally {
    await lock.release();
  }
}

/** Discard interrupted stages while holding the same exclusive profile lock as a live agent. */
export async function discardPendingAuthStages(agent: AgentName, name: string): Promise<void> {
  const profile = await loadAuthProfile(agent, name);
  const lock = await acquireAuthProfile(profile);
  try {
    await discardStages(profile);
  } finally {
    await lock.release();
  }
}

/** Unlock only after the profile owner and its managed container are absent. */
export async function removeAuthProfileLock(agent: AgentName, name: string): Promise<void> {
  await removeProfileLock(await loadAuthProfile(agent, name));
}
