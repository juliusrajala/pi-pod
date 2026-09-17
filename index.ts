export { login } from "./src/execution/login.ts";
export { runAgent } from "./src/execution/run.ts";
export { removeAgentRun } from "./src/workspace/remove.ts";
export { prepareWorkspace } from "./src/workspace/prepare.ts";
export { buildPodmanRunArgs } from "./src/container/args.ts";
export {
  discardPendingAuthStages,
  recoverAuthProfile,
  removeAuthProfileLock,
} from "./src/auth/recovery.ts";
export type {
  AgentPreferences,
  ModelPreference,
  OpenCodeAgentPreferences,
  PiAgentPreferences,
  PiThinkingLevel,
} from "./src/config/types.ts";
export type {
  AgentName,
  AuthOutcome,
  LoginOptions,
  LoginResult,
  OutputOutcome,
  OutputSinks,
  PreparedWorkspace,
  ResourceLimits,
  RunAgentOptions,
  RunMode,
  RunResult,
  WorkspaceMode,
} from "./src/execution/types.ts";
