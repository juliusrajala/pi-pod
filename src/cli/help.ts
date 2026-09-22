import { defaultImage } from "../container/image.ts";

/** Curated help is kept separate from parser output so it can state boundary policy once. */
export const usage = `Usage:
  pi-pod build [--image <image>]
  pi-pod dev <directory> [options] [-- <agent arguments>]
  pi-pod run <directory> --prompt <text>|--prompt-file <path> [options] [-- <agent arguments>]
  pi-pod remove <run-id>
  pi-pod auth profile <create|list|show|update|remove> [options]
  pi-pod auth default <set|show|clear> --agent <pi|opencode> [--auth <host|profile>]

Run options:
  --agent <pi|opencode>       Pi is the default
  --workspace <bind|clone>    dev defaults to bind; run defaults to clone
  --auth <host|profile>       defaults to the per-agent CLI source, then host
  --image <image>             default: ${defaultImage}
  --config <absolute path>    selected agent/mode preferences; dev replaces automatic config
  --no-config                 dev only; skip the automatic/explicit preference file layer
  --timeout <seconds>         run only; default is 600 seconds
  --network <pasta|none>      default: pasta
  --relabel-workspace         explicitly allow Podman SELinux relabeling of a bind workspace
  --memory <size> --cpus <n> --pids <n> --workspace-bytes <n> --temporary-bytes <n>

Examples:
  pi-pod build
  pi-pod dev .
  pi-pod run . --prompt "Fix the failing unit tests"
  pi-pod auth profile create --agent opencode --provider anthropic --profile worker
  pi-pod run . --auth worker --prompt-file task.md
`;

export function isWrapperHelpRequest(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  const wrapperArgs = argv.slice(0, separator === -1 ? argv.length : separator);
  return (
    wrapperArgs.length === 0 ||
    wrapperArgs.includes("--help") ||
    wrapperArgs.includes("-h") ||
    wrapperArgs[0] === "help"
  );
}
