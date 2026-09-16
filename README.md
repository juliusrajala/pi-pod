# pi-pod

Run Pi or OpenCode in a rootless Podman container with only one writable project mount. It is intended for local development now and as a reusable execution boundary for an orchestrator later.

`pi-pod` is a Bun library plus CLI for local/self-hosted use. It owns workspace preparation, authentication staging, Podman restrictions, cancellation, and retained clones. It does **not** commit, push, open pull requests, copy changes back, or run a daemon. Source is public at [github.com/juliusrajala/pi-pod](https://github.com/juliusrajala/pi-pod); the package remains private, so registry publication is not a v0.1 goal.

## Requirements

- Linux with local **rootless** Podman and cgroup v2 resource limits. If a tmux/terminal scope does not delegate CPU control, the CLI automatically enters a transient delegated user scope; this requires `systemd-run --user`.
- Bun 1.3.14 or later
- Git for clone mode
- A provider account or explicitly forwarded API key

This checkout pins Bun `1.3.14` in `.mise.toml`; the launcher refuses an older runtime before it loads CLI code. Activate mise in your shell, or run `PATH="$(dirname "$(mise which bun)"):$PATH" ./bin/pi-pod --help` from this checkout.

Clone the source and build the pinned image:

```bash
git clone https://github.com/juliusrajala/pi-pod.git
cd pi-pod
bun install
./bin/pi-pod build
```

The image is `localhost/pi-pod:0.1.0` and contains pinned Pi `0.85.1`, OpenCode `1.18.27`, Bun `1.3.14`, Node, Git, Bash, `fd`, and ripgrep. The build uses a pinned Node base digest and validates the downloaded Bun checksum. It currently targets `linux/amd64`.

From this source checkout, invoke the CLI through its launcher:

```bash
./bin/pi-pod --help
```

The launcher starts Bun from this trusted package directory, disables automatic `.env` loading, then restores your original directory before interpreting a workspace path. This prevents a target repository's `bunfig.toml` preload from running on the host. Do not invoke `src/cli.ts` directly from an untrusted workspace.

The package also declares a `pi-pod` binary for a linked/installed package; use `pi-pod` in that case. A local Bun consumer can install it with `bun add /path/to/pi-pod` and then run `pi-pod --help` with Bun 1.3.14 or later.

## Credentials: development versus autonomous work

### Interactive Pi development

`./bin/pi-pod dev .` defaults to `--auth host` for Pi. It reads your existing `~/.pi/agent/auth.json`, validates and stages only its `openai-codex` credential in a private temporary directory, then starts the interactive container. It does **not** mount your host Pi directory or write the staged credential back to the host file.

Dev loads trusted Pi extensions by default. It mounts `~/.pi/agent/extensions/` read-only, plus read-only local package roots referenced by your host Pi settings; pi-pod generates a filtered settings file containing only those package extension declarations and the host default provider/model/thinking level. It does not mount general settings, sessions, skills, themes, analytics, or credentials. Pass Pi's explicit flag after the separator to disable all extensions: `./bin/pi-pod dev . -- --no-extensions`. Remote npm/git package sources are rejected rather than installed in the container.

This is the local development path for a Codex subscription: no second container OAuth login is required. A provider can rotate tokens server-side, so a later host Pi login may need refreshing even though pi-pod never writes the host file. Use `--auth <profile>` or `--auth none` to opt out of host credentials. Host credentials are rejected for `run` and all headless/library-autonomous use.

### Autonomous profiles

Headless `run` defaults to the pi-pod-owned `default` profile under `$XDG_STATE_HOME/pi-pod/auth/` (or `~/.local/state/pi-pod/auth/`). It never reads `~/.pi/agent`. An orchestrator may instead use `--auth none` and explicitly forward a task-specific API-key environment variable.

Create a pi-pod-owned profile only when an autonomous provider needs one:

```bash
./bin/pi-pod login --agent pi --provider openai-codex --profile worker
# or an intended native OpenCode provider
./bin/pi-pod login --agent opencode --provider <provider-id> --profile worker
```

The login container stages credentials privately and persists only the selected provider credential on a verified exit. Profiles default to `default`; use `--profile work` to make another one. Exactly one container can use a profile at a time so rotating OAuth tokens cannot race. If a process is interrupted while reconciling credentials:

```bash
./bin/pi-pod auth recover --agent pi --profile default
# Use only when recovery reports an invalid unwanted stage.
./bin/pi-pod auth discard --agent pi --profile default
# Only removes a stale lock after its recorded PID and container are gone.
./bin/pi-pod auth unlock --agent pi --profile default
```

Persistent credentials do not imply persistent Pi/OpenCode sessions, plugins, analytics, or personal configuration.

### Required manual OAuth validation for autonomous profiles

This cannot run in CI and must never expose a token. After building the image, validate each subscription provider intended for local use in a disposable empty directory:

1. Run `./bin/pi-pod login --agent pi --provider openai-codex --profile v01-check` and complete Pi's device-code flow inside the container. Exit with `/quit`.
2. In a new terminal process, run `./bin/pi-pod run /path/to/empty-dir --workspace bind --auth v01-check --prompt "Reply only: AUTH_OK" --timeout 60`. Confirm it completes without another login flow.
3. Repeat the second command after the provider refreshes or expires the access token. Confirm the run still completes; do not inspect, print, or copy the stored credential.
4. For every intended OpenCode subscription provider, repeat login and a new-process run with `--agent opencode --provider <provider-id>`. Record only provider name, command exit status, and whether reuse/refresh succeeded.

Use a dedicated profile so this validation cannot affect the default profile, and never commit its state directory. Provider-specific account availability and token-expiry timing determine when step 3 can be performed.

## Use it

### Interactive, direct development

`dev` mounts the supplied folder directly by default. It is appropriate when a human editor and the agent should change the same checkout.

```bash
./bin/pi-pod dev .
./bin/pi-pod dev . --agent opencode
```

The folder may be dirty. It is never removed, reset, committed, or copied by the wrapper. Linked Git worktrees are rejected because their Git metadata lives outside the mount.

Use clone mode for an interactive isolated checkout instead:

```bash
./bin/pi-pod dev . --workspace clone
```

### Headless isolated run

`run` defaults to `clone` and has a ten-minute timeout:

```bash
./bin/pi-pod run . --prompt "Fix the failing unit tests"
./bin/pi-pod run . --agent opencode --prompt-file task.md
```

A prompt file is bounded to 256 KiB, copied into wrapper-owned private state, and mounted read-only at a fixed container path. Its contents are not placed in the host Podman command line.

Clone mode requires a clean normal Git repository. It creates an independent clone of **local `HEAD`**, so committed but unpushed work is included; uncommitted, untracked, ignored files, and installed dependencies are not. It does not use a Git worktree, hard links, an object alternate, source hooks, source remotes, submodules, or Git filter attributes.

Every clone that reaches agent startup is retained at:

```text
$XDG_STATE_HOME/pi-pod/runs/<run-id>/workspace
```

The CLI prints the run ID and path. Review, diff, commit, or manually apply the work as desired; then remove it explicitly:

```bash
./bin/pi-pod remove <run-id>
```

`remove` refuses while a labeled container for that run remains, or while its wrapper is still preparing that clone. The wrapper only removes its own retained clone directory, never a bind workspace.

### API-key alternative

Do not use an auth profile and forward only named variables that are required for this task:

```bash
./bin/pi-pod run . \
  --auth none \
  --env ANTHROPIC_API_KEY \
  --prompt "Summarize the repository"
```

Values travel in the Podman client environment, not command-line arguments. `GITHUB_TOKEN`, `GH_TOKEN`, database credentials, SSH-agent access, Git askpass, and selected cloud-secret variables are always rejected. Do not pass a credential unless repository code run by the agent may receive it.

### Common options

```text
--agent pi|opencode
--workspace bind|clone
--auth host|<profile>|none          host is interactive-Pi-dev only
--env NAME                         repeatable explicit forwarding
--image IMAGE
--timeout SECONDS                  headless only; defaults to 600
--network pasta|none               defaults to pasta
--relabel-workspace                explicit recursive SELinux relabel for a bind mount
--memory SIZE --cpus N --pids N
--workspace-bytes N --temporary-bytes N
-- <agent-specific arguments>
```

The default limits are 4 GiB memory, 4 CPUs, 512 processes, 4 GiB workspace storage monitoring, and 512 MiB each for `/tmp` and container home. `--network none` is useful for a no-network inspection, but a remote model provider needs `pasta`.

## Container boundary

Each run uses:

- rootless Podman, `--userns=keep-id`, current caller UID/GID, and an init process;
- a read-only image root, dropped Linux capabilities, `no-new-privileges`, default Podman seccomp/SELinux separation, private process namespaces, and no container/desktop/SSH sockets;
- writable `/workspace`, plus bounded tmpfs `/tmp` and `/home/agent` only;
- no host networking, published ports, proxy forwarding, host home, parent project directories, or arbitrary Podman-option escape hatch;
- rootless `pasta` networking by default without published ports; Podman disables automatic pasta forwarding when no port is published;
- a container-local, otherwise empty agent home. Interactive Pi `dev` stages the selected host Codex credential and mounts trusted host extension directories/local extension packages read-only; host sessions, general settings, analytics, Swarmia configuration, skills, MCP servers, and shell configuration are not imported;
- explicit Pi flags which disable extension/skill/prompt/theme discovery. Headless Pi also disables context files and declines project trust. OpenCode runs with `--pure`, preserves its bundled subscription integrations, and disables sharing/snapshots/autoupdate; its project configuration merging remains an OpenCode behavior, but it executes only inside the container.

For a wrapper-owned clone and credential staging directory, Podman applies private SELinux relabeling. A direct workspace is **not** relabeled by default because that recursively changes host labels. Pass `--relabel-workspace` only after deciding that it is appropriate for that folder.

### Important limits

This is containment, not a sealed vault:

- A `bind` mount lets the agent destructively modify any file in that project, including readable `.env` files and Git configuration.
- Any credential given to an agent can be read or exfiltrated by repository code that it runs.
- `pasta` is not an outbound network allowlist; network-enabled containers can reach provider and network services.
- The storage monitor fails closed and avoids symlinks, but may overshoot between checks. A quota-backed state filesystem is necessary for a hard aggregate disk limit.
- Containers share the host kernel. Do not treat this as a defense against every hostile-code risk.

## Library API

The public API is for a **trusted host caller**. An orchestrator must still authorize workspace paths, images, credentials, and resource limits before calling it.

```ts
import { runAgent } from "pi-pod";

const result = await runAgent({
  agent: "pi",
  mode: "headless",
  workspace: "/srv/jobs/job-123/workspace",
  workspaceMode: "bind", // orchestrator prepared this checkout
  authProfile: "default",
  prompt: "Implement the requested change and run relevant tests.",
  timeoutMs: 10 * 60_000,
});

console.log(result.exitCode, result.workspace.path, result.auth);
```

`RunResult.auth` identifies a host, profile, or absent credential source and distinguishes persisted credentials from staging retained for recovery, while `RunResult.output` reports stream-delivery failure. Trusted library callers may supply `output: { stdout, stderr }` Web `WritableStream` sinks to consume agent output with backpressure; omitting them inherits the terminal.

Exports also include `login`, `removeAgentRun`, `prepareWorkspace`, `recoverAuthProfile`, and `buildPodmanRunArgs`.

## Test

```bash
bun test
bun run typecheck
```

The normal suite uses temporary Git/auth fixtures. It does not access provider accounts, personal configuration, real repositories, or forge credentials. The Podman mount/image boundary smoke test is opt-in after building the image:

```bash
PI_POD_INTEGRATION=1 bun test src/podman.integration.test.ts
# Exercises automatic transient-scope delegation with fake Podman and a pseudo-terminal.
PI_POD_SYSTEMD_INTEGRATION=1 bun test src/cli/delegation.integration.test.ts
```

A real subscription login and token-refresh smoke test requires your participation and should never print or commit tokens.
