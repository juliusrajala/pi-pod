import { defaultImage } from "../defaults.ts";

export const usage = `Usage:
  pi-pod build [--image <image>]
  pi-pod login --agent <pi|opencode> --provider <provider> [--profile <name>] [--image <image>]
  pi-pod dev <directory> [options] [-- <agent arguments>]
  pi-pod run <directory> --prompt <text>|--prompt-file <path> [options] [-- <agent arguments>]
  pi-pod remove <run-id>
  pi-pod auth <recover|discard|unlock> --agent <pi|opencode> [--profile <name>]

Run options:
  --agent <pi|opencode>       Pi is the default
  --workspace <bind|clone>    dev defaults to bind; run defaults to clone
  --auth <host|profile|none>  dev defaults to host; run defaults to profile "default"
  --env <NAME>                Forward one explicitly named environment variable (repeatable)
  --image <image>             default: ${defaultImage}
  --config <absolute path>    selected agent/mode preferences; dev replaces automatic config
  --no-config                 dev only; skip the automatic/explicit preference file layer
  --timeout <seconds>         run only; default is 600 seconds
  --network <pasta|none>      default: pasta
  --relabel-workspace         explicitly allow Podman SELinux relabeling of a bind workspace
  --memory <size> --cpus <n> --pids <n> --workspace-bytes <n> --temporary-bytes <n>

Examples:
  pi-pod build
  pi-pod login --agent pi --provider openai-codex
  pi-pod dev .
  pi-pod dev . --workspace clone
  pi-pod run . --prompt "Fix the failing unit tests"
  pi-pod run . --auth none --env OPENAI_API_KEY --prompt-file task.md
`;

export function isWrapperHelpRequest(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  const wrapperArgs = argv.slice(0, separator === -1 ? argv.length : separator);
  return wrapperArgs.length === 0 || wrapperArgs.includes("--help") || wrapperArgs.includes("-h") || wrapperArgs[0] === "help";
}
