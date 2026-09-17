import { podmanNeedsDelegatedScope } from "../container/args.ts";

const delegationMarker = "PI_POD_DELEGATED_SCOPE";

/**
 * Run container commands in a transient user scope when a terminal's cgroup
 * does not delegate the CPU controller. This keeps the normal CLI usable from
 * tmux while preserving pi-pod's CPU, memory, and process limits.
 */
export async function reexecInDelegatedScope(argv: readonly string[]): Promise<boolean> {
  if (Bun.env[delegationMarker] === "1" || !(await podmanNeedsDelegatedScope())) return false;

  const launcher = Bun.env.PI_POD_LAUNCHER;
  if (launcher === undefined) {
    throw new Error(
      "pi-pod needs a delegated cgroup scope; invoke it through the pi-pod launcher.",
    );
  }

  console.error(
    "pi-pod: entering a delegated user scope to enforce CPU, memory, and process limits.",
  );
  const child = Bun.spawn(delegatedScopeArgs(launcher, argv), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
  return true;
}

export function delegatedScopeArgs(launcher: string, argv: readonly string[]): string[] {
  const environment = [
    `${delegationMarker}=1`,
    ...[
      "PATH",
      "HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "TERM",
      "COLORTERM",
    ].flatMap((name) => (Bun.env[name] === undefined ? [] : [`${name}=${Bun.env[name]}`])),
  ];
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--same-dir",
    "--property=Delegate=yes",
    ...environment.map((value) => `--setenv=${value}`),
    launcher,
    ...argv,
  ];
}
