import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const enabled =
  Bun.env.PI_POD_SYSTEMD_INTEGRATION === "1" &&
  Bun.which("systemd-run") !== null &&
  Bun.which("script") !== null;

test.if(enabled)(
  "re-execs the normal launcher into a delegated tmux-compatible scope",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-pod-delegation-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const marker = join(root, "delegated-run");
    const launcher = resolve(import.meta.dir, "..", "..", "bin", "pi-pod");
    try {
      await mkdir(bin);
      await mkdir(workspace);
      await writeFile(
        join(bin, "podman"),
        `#!/bin/sh
case "$1" in
  info)
    group=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
    if grep -qw cpu "/sys/fs/cgroup$group/cgroup.controllers"; then
      printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["cpu","memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}'
    else
      printf '%s\\n' '{"host":{"os":"linux","cgroupVersion":"v2","cgroupControllers":["memory","pids"],"serviceIsRemote":false,"security":{"rootless":true}}}'
    fi
    ;;
  run) printf delegated > ${shellQuote(marker)} ;;
  container) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );
      await chmod(join(bin, "podman"), 0o700);
      const environment: Record<string, string | undefined> = {
        ...Bun.env,
        PATH: `${bin}:${dirname(process.execPath)}:${Bun.env.PATH ?? ""}`,
        XDG_STATE_HOME: join(root, "state"),
      };
      delete environment.PI_POD_DELEGATED_SCOPE;
      const child = Bun.spawn(
        [launcher, "run", workspace, "--workspace", "bind", "--auth", "none", "--prompt", "probe"],
        { env: environment, stdout: "ignore", stderr: "ignore" },
      );
      const exitCode = await child.exited;

      expect(exitCode).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("delegated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test.if(enabled)(
  "keeps an interactive terminal attached inside the delegated scope",
  async () => {
    const child = Bun.spawn(
      [
        "script",
        "-qefc",
        "systemd-run --user --scope --quiet --property=Delegate=yes sh -c 'test -t 0 && test -t 1 && test -t 2 && printf tty-preserved'",
        "/dev/null",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("tty-preserved");
  },
  20_000,
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
