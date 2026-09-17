import type { AgentDefinition } from "../contract.ts";
import {
  assertModelPreference,
  isBoundedNonemptyString,
  isRecord,
  type AgentPreferences,
  type OpenCodeAgentPreferences,
} from "../../config/types.ts";
import { openCodeCredentialCodec } from "./credentials.ts";

function validatePreferences(agentPreferences: AgentPreferences): OpenCodeAgentPreferences {
  if (!isRecord(agentPreferences)) {
    throw new Error("Agent preferences should be an object");
  }

  if (Object.keys(agentPreferences).some((key) => key !== "model" && key !== "variant")) {
    throw new Error("OpenCode preferences support only model and variant.");
  }

  return agentPreferences;
}

export const openCodeDefinition: AgentDefinition = {
  id: "opencode",
  modes: ["interactive", "headless"],
  authDirectory: "/home/agent/.local/share/opencode",
  environment: {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    XDG_DATA_HOME: "/home/agent/.local/share",
    XDG_CACHE_HOME: "/home/agent/.cache",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      snapshot: false,
    }),
  },
  credentialCodec: openCodeCredentialCodec,
  hostAuth: { provider: "openai", source: "host-opencode" },
  preferenceArguments(preferences, agentArgs) {
    if (preferences === undefined) return [];

    const validPreferences = validatePreferences(preferences);

    const args: string[] = [];
    if (validPreferences.model !== undefined) {
      assertModelPreference(validPreferences.model, "OpenCode model");
      if (!hasAnyFlag(agentArgs, ["--model", "-m"])) {
        args.push("--model", `${validPreferences.model.provider}/${validPreferences.model.id}`);
      }
    }
    const variant = (validPreferences as { variant?: unknown }).variant;
    if (variant !== undefined) {
      if (!isBoundedNonemptyString(variant, 128)) {
        throw new Error("OpenCode variant must be a nonempty string up to 128 characters.");
      }
      if (!hasAnyFlag(agentArgs, ["--variant"])) args.push("--variant", variant);
    }
    return args;
  },
  command: ({ mode, promptPath, agentArgs }) =>
    mode === "interactive"
      ? ["opencode", "--pure", ...agentArgs]
      : promptPath === undefined
        ? ["opencode", "run", "--pure", "--auto", ...agentArgs, ""]
        : promptFileCommand(promptPath, agentArgs),
  loginCommand: (provider) => ["opencode", "auth", "login", "--provider", provider],
  loginInstructions: (provider) => `Complete OpenCode's native login for ${provider}.`,
};

function hasAnyFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function promptFileCommand(promptPath: string, agentArgs: readonly string[]): string[] {
  // Appending a sentinel prevents command substitution from dropping prompt
  // trailing newlines. Neither prompt text nor agent arguments are interpolated.
  return [
    "sh",
    "-c",
    'prompt=$(cat -- "$1"; printf .); prompt=${prompt%.}; shift; exec opencode run --pure --auto "$@" -- "$prompt"',
    "pi-pod-prompt",
    promptPath,
    ...agentArgs,
  ];
}
