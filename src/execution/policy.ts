import { agentDefinition, assertAgentMode, type AgentDefinition } from "../agents/registry.ts";
import { defaultHeadlessTimeoutMs, defaultImage } from "../container/image.ts";
import { resolvedResourceLimits, resolvedTimeoutMs } from "../resources/limits.ts";
import type { AgentPreferences } from "../config/types.ts";
import type { AgentName, ResourceLimits, RunAgentOptions, WorkspaceMode } from "./types.ts";
import type { CredentialSource } from "./credentials.ts";

/** Pure policy resolution for explicit public-library credential sources. */
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
  preferenceArgs: string[];
};

export function resolveRunPolicy(
  input: RunAgentOptions,
  options: { allowHeadlessHostAuth?: boolean } = {},
): ResolvedRunPolicy {
  const agent = input.agent ?? "pi";
  const definition = agentDefinition(agent);
  assertAgentMode(definition, input.mode);
  if (
    input.mode === "headless" &&
    input.auth.type !== "profile" &&
    options.allowHeadlessHostAuth !== true
  ) {
    throw new Error("Headless library runs require an explicit API-token profile.");
  }
  if (input.auth.type === "host" && definition.hostAuth === undefined) {
    throw new Error(`${agent} does not support host authentication.`);
  }
  if (
    input.auth.type === "profile" &&
    (!input.auth.name || input.auth.name === "host" || input.auth.name === "none")
  ) {
    throw new Error("A non-host auth profile name is required.");
  }
  const preferences = input.preferences;
  const preferenceArgs = definition.preferenceArguments(preferences, input.agentArgs ?? []);
  return {
    agent,
    definition,
    workspaceMode: input.workspaceMode ?? (input.mode === "interactive" ? "bind" : "clone"),
    credentialSource:
      input.auth.type === "host"
        ? { source: "host" }
        : { source: "profile", profileName: input.auth.name },
    limits: resolvedResourceLimits(input.limits),
    image: input.image?.trim() || defaultImage,
    timeoutMs: resolvedTimeoutMs(input.mode, input.timeoutMs, defaultHeadlessTimeoutMs),
    network: input.network ?? "pasta",
    ...(preferences === undefined ? {} : { preferences }),
    preferenceArgs,
  };
}
