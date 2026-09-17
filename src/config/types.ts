/** A provider and model ID always travel together; neither inherits separately. */
export type ModelPreference = {
  provider: string;
  id: string;
};

export const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof piThinkingLevels)[number];

export type PiAgentPreferences = {
  model?: ModelPreference;
  thinking?: PiThinkingLevel;
};

export type OpenCodeAgentPreferences = {
  model?: ModelPreference;
  /** Native provider-specific reasoning variant, such as high or max. */
  variant?: string;
};

/** Validated preferences for one selected agent and one selected mode. */
export type AgentPreferences = PiAgentPreferences | OpenCodeAgentPreferences;

export function assertModelPreference(value: unknown, field = "model"): asserts value is ModelPreference {
  if (!isRecord(value) || !hasOnlyKeys(value, ["provider", "id"]) ||
    !isBoundedNonemptyString(value.provider) || !isBoundedNonemptyString(value.id)) {
    throw new Error(`${field} requires nonempty provider and id strings.`);
  }
}

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (piThinkingLevels as readonly string[]).includes(value);
}

export function isBoundedNonemptyString(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
