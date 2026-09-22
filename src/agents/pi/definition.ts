import type { AgentDefinition } from "../contract.ts";
import { assertModelPreference, isPiThinkingLevel, isRecord } from "../../config/types.ts";
import { piCredentialCodec } from "./credentials.ts";

export const piDefinition: AgentDefinition = {
  id: "pi",
  modes: ["interactive", "headless"],
  authDirectory: "/home/agent/.pi/agent",
  environment: {
    HOME: "/home/agent",
    PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
    /** Allows reviewed Pi extensions to identify this contained session. */
    PI_POD_CONTAINER: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  },
  credentialCodec: piCredentialCodec,
  hostAuth: { provider: "openai-codex", source: "host-pi" },
  interactiveDevResources: "pi",
  preferenceArguments(preferences, agentArgs) {
    if (preferences === undefined) return [];
    if (
      !isRecord(preferences) ||
      Object.keys(preferences).some((key) => key !== "model" && key !== "thinking")
    ) {
      throw new Error("Pi preferences support only model and thinking.");
    }
    const args: string[] = [];
    if (preferences.model !== undefined) {
      assertModelPreference(preferences.model, "Pi model");
      // Do not combine a configured provider with a passthrough model (or the
      // reverse): a model selection is atomic and native argv wins entirely.
      if (!hasAnyFlag(agentArgs, ["--provider", "--model"])) {
        args.push("--provider", preferences.model.provider, "--model", preferences.model.id);
      }
    }
    const thinking = (preferences as { thinking?: unknown }).thinking;
    if (thinking !== undefined) {
      if (!isPiThinkingLevel(thinking)) {
        throw new Error(
          "Pi thinking must be one of off, minimal, low, medium, high, xhigh, or max.",
        );
      }
      if (!hasAnyFlag(agentArgs, ["--thinking"])) args.push("--thinking", thinking);
    }
    return args;
  },
  command: ({ mode, promptPath, agentArgs }) =>
    mode === "interactive"
      ? ["pi", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", ...agentArgs]
      : promptPath === undefined
        ? [
            "pi",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--print",
            ...agentArgs,
            "",
          ]
        : promptFileCommand(promptPath, agentArgs),
};

function hasAnyFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function promptFileCommand(promptPath: string, agentArgs: readonly string[]): string[] {
  return promptCommand(
    'exec pi --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --print "$@" -- "$prompt"',
    promptPath,
    agentArgs,
  );
}

function promptCommand(
  command: string,
  promptPath: string,
  agentArgs: readonly string[],
): string[] {
  // Appending a sentinel prevents command substitution from dropping prompt
  // trailing newlines. Neither prompt text nor agent arguments are interpolated.
  return [
    "sh",
    "-c",
    `prompt=$(cat -- "$1"; printf .); prompt=\${prompt%.}; shift; ${command}`,
    "pi-pod-prompt",
    promptPath,
    ...agentArgs,
  ];
}
