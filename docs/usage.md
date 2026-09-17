# Usage

Invoke a source checkout through `./scripts/dev-launcher`, not `src/cli.ts` from a target workspace. The launcher starts Bun from the trusted package directory and disables workspace-controlled Bun configuration.

```sh
./scripts/dev-launcher build
./scripts/dev-launcher dev .
./scripts/dev-launcher dev . --agent opencode
./scripts/dev-launcher run . --prompt "Fix the failing unit tests"
./scripts/dev-launcher run . --auth none --env ANTHROPIC_API_KEY --prompt-file task.md
```

## Workspace modes

`dev` defaults to `bind`: the agent modifies the supplied folder directly. It may be dirty, but pi-pod never commits, resets, copies back, or removes it. Linked Git worktrees are rejected.

`run` defaults to `clone`: pi-pod requires a clean normal Git repository and clones local `HEAD` into wrapper-owned state. Committed but unpushed work is included; uncommitted, ignored, and untracked files are not. Every launched clone is retained until you review it and run:

```sh
./scripts/dev-launcher remove <run-id>
```

`remove` refuses while the exact run container or its preparation reservation exists. It never removes a bind workspace.

## Options and passthrough

```text
--agent pi|opencode
--workspace bind|clone
--auth host|<profile>|none
--env NAME                         repeatable, explicit API-key forwarding
--image IMAGE
--config /absolute/path.json          explicit agent/mode model preferences
--no-config                           dev only; skip the preference-file layer
--timeout SECONDS                  run only; defaults to 600
--network pasta|none
--relabel-workspace
--memory SIZE --cpus N --pids N
--workspace-bytes N --temporary-bytes N
-- <agent-specific arguments>
```

Only `dev` and `run` accept tokens after `--`; they are passed to the selected container agent unchanged. Native `--provider`/`--model`/`--thinking` (Pi) and `--model`/`-m`/`--variant` (OpenCode) override their matching preference-file fields without a duplicate flag. Wrapper flags are parsed and rejected before workspace, auth, or Podman side effects. See [configuration.md](configuration.md) for preference-file loading and precedence.

`--network none` is useful for local inspection. Remote model providers need the default `pasta` network. The default limits are 4 GiB memory, 4 CPUs, 512 processes, 4 GiB workspace monitoring, and 512 MiB each for `/tmp` and the container home. Monitoring is not a hard aggregate disk quota.

Use `--relabel-workspace` only after deciding that recursive SELinux relabeling is appropriate for that bind directory. Wrapper-owned clones and staging directories receive private relabeling automatically.

## Troubleshooting

- **Prerequisites:** pi-pod requires native Linux, local rootless Podman, cgroup v2 controllers, and sometimes `systemd-run --user` for a delegated terminal scope.
- **Image:** run `./scripts/dev-launcher build` (or `./pi-pod build` from a Linux x64 release bundle); launches never pull or build an image automatically.
- **Entrypoint:** contributors and local Bun packages use the development `scripts/dev-launcher`. A Linux x64 release bundle uses its compiled host controller, adjacent audited `container/Containerfile`, and `SHA256SUMS`; it still requires rootless Podman and does not contain Pi or OpenCode.
- **Authentication:** see [authentication.md](authentication.md). Do not delete state broadly; use the named recovery command only after its diagnostic says the stage is safe to recover or discard.
- **Workspace:** clone mode requires clean local Git history; use `--workspace bind` for a dirty human checkout.
- **Execution and cleanup:** a retained clone or auth stage means pi-pod could not prove safe cleanup. Keep it for recovery rather than removing state manually.
