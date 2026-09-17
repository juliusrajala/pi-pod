import { agentDefinition, assertAgentMode, type AgentDefinition } from "../agents/registry.ts";
import { defaultHeadlessTimeoutMs, defaultImage } from "../defaults.ts";
import { resolvedResourceLimits, resolvedTimeoutMs } from "../options.ts";
import type { AgentPreferences } from "../config/types.ts";
import type { AgentName, ResourceLimits, RunAgentOptions, WorkspaceMode } from "../types.ts";
import { resolveCredentialSource, type CredentialSource } from "./credentials.ts";

/** Pure default and capability resolution shared by CLI-backed and library runs. */
export type ResolvedRunPolicy = {
  agent: AgentName;
  definition: AgentDefinition;
  workspaceMode: WorkspaceMode;
  credentialSource: { source: CredentialSource; profileName?: string };
  limits: ResourceLimits;
  image: string;
  timeoutMs: number | undefined;
  network: "pasta" | "none";
  preferences?: AgentPreferences;
  /** Configured flags are placed before native passthrough; passthrough wins. */
  preferenceArgs: string[];
};

export function resolveRunPolicy(input: RunAgentOptions): ResolvedRunPolicy {
  const agent = input.agent ?? "pi";
  const definition = agentDefinition(agent);
  assertAgentMode(definition, input.mode);
  const preferences = input.preferences;
  const preferenceArgs = definition.preferenceArguments(preferences, input.agentArgs ?? []);
  return {
    agent,
    definition,
    workspaceMode: input.workspaceMode ?? (input.mode === "interactive" ? "bind" : "clone"),
    credentialSource: resolveCredentialSource({ agent, mode: input.mode, authProfile: input.authProfile }),
    limits: resolvedResourceLimits(input.limits),
    image: input.image?.trim() || defaultImage,
    timeoutMs: resolvedTimeoutMs(input.mode, input.timeoutMs, defaultHeadlessTimeoutMs),
    network: input.network ?? "pasta",
    ...(preferences === undefined ? {} : { preferences }),
    preferenceArgs,
  };
}
