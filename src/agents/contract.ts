import type { AgentPreferences } from "../config/types.ts";
import type { RunMode } from "../types.ts";

/** Closed built-in IDs. There is no runtime agent/plugin discovery. */
export const agentNames = ["pi", "opencode"] as const;
export type AgentName = (typeof agentNames)[number];

export type CredentialCodec = {
  assertProvider: (provider: string) => void;
  normalize: (provider: string, value: unknown) => Record<string, unknown>;
};

export type HostAuthCapability = {
  /** Selected native provider; this does not accept a caller-controlled path. */
  provider: string;
  /** Internal host-auth coordinator key, not a host filesystem path. */
  source: "host-pi" | "host-opencode";
};

/** Reviewed native differences; containment and lifecycle remain pi-pod policy. */
export type AgentDefinition = {
  id: string;
  modes: readonly RunMode[];
  authDirectory: string;
  environment: Readonly<Record<string, string>>;
  credentialCodec: CredentialCodec;
  hostAuth?: HostAuthCapability;
  /** Pi-only filtered interactive extension/resource support. */
  interactiveDevResources?: "pi";
  /** Translate only reviewed native model/behavior flags; no Podman policy. */
  preferenceArguments: (preferences: AgentPreferences | undefined, agentArgs: readonly string[]) => string[];
  command: (input: {
    mode: RunMode;
    /** Fixed container path to a wrapper-owned, read-only task file. */
    promptPath?: string;
    agentArgs: readonly string[];
  }) => string[];
  loginCommand: (provider: string) => string[];
  loginInstructions: (provider: string) => string;
};
