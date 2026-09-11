import type { AgentName, RunMode } from "./types.ts";

export type AgentDefinition = {
  authDirectory: string;
  environment: Record<string, string>;
  command: (input: {
    mode: RunMode;
    /** Fixed container path to a wrapper-owned, read-only task file. */
    promptPath?: string;
    agentArgs: readonly string[];
  }) => string[];
};

const piAuthDirectory = "/home/agent/.pi/agent";
const openCodeAuthDirectory = "/home/agent/.local/share/opencode";

export function agentDefinition(agent: AgentName): AgentDefinition {
  if (agent === "pi") {
    return {
      authDirectory: piAuthDirectory,
      environment: {
        HOME: "/home/agent",
        PI_CODING_AGENT_DIR: "/home/agent/.pi/agent",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
      command: ({ mode, promptPath, agentArgs }) => mode === "interactive"
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
          : promptFileCommand("pi", promptPath, agentArgs),
    };
  }

  return {
    authDirectory: openCodeAuthDirectory,
    environment: {
      HOME: "/home/agent",
      XDG_CONFIG_HOME: "/home/agent/.config",
      XDG_DATA_HOME: "/home/agent/.local/share",
      XDG_CACHE_HOME: "/home/agent/.cache",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", snapshot: false }),
    },
    command: ({ mode, promptPath, agentArgs }) => mode === "interactive"
      ? ["opencode", "--pure", ...agentArgs]
      : promptPath === undefined
        ? ["opencode", "run", "--pure", "--auto", ...agentArgs, ""]
        : promptFileCommand("opencode", promptPath, agentArgs),
  };
}

function promptFileCommand(agent: AgentName, promptPath: string, agentArgs: readonly string[]): string[] {
  const command = agent === "pi"
    ? "exec pi --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --print \"$@\" -- \"$prompt\""
    : "exec opencode run --pure --auto \"$@\" -- \"$prompt\"";
  // Appending a sentinel prevents command substitution from dropping prompt
  // trailing newlines. Neither prompt text nor agent arguments are interpolated
  // into this fixed shell program.
  return [
    "sh",
    "-c",
    `prompt=$(cat -- "$1"; printf .); prompt=\${prompt%.}; shift; ${command}`,
    "pi-pod-prompt",
    promptPath,
    ...agentArgs,
  ];
}

export function loginCommand(agent: AgentName, provider: string): string[] {
  if (agent === "pi") {
    // Pi's subscription login is an interactive slash command. Keeping the
    // provider outside argv avoids pretending Pi exposes a stable CLI login.
    return ["pi", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];
  }
  return ["opencode", "auth", "login", "--provider", provider];
}

export function loginInstructions(agent: AgentName, provider: string): string {
  if (agent === "pi") {
    return `In Pi, run /login and choose ${provider}. For ChatGPT/Codex, choose device-code login to avoid a container callback port.`;
  }
  return `Complete OpenCode's native login for ${provider}.`;
}
