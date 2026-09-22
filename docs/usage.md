# Usage

Set up the compiled CLI and build the agent image using the [installation guide](installation.md). Examples below run from the bundle directory; replace `/path/to/your-project` with your project directory. From another directory, use the absolute path to the bundle's `pi-pod` executable.

## Choose a workflow

|                        | Interactive `dev`                        | Headless `run`                        |
| ---------------------- | ---------------------------------------- | ------------------------------------- |
| Use it for             | Working alongside an agent               | Giving an agent a task to complete    |
| Default workspace      | Your directory, edited directly (`bind`) | A separate local-HEAD clone (`clone`) |
| Default authentication | Selected host credential (`host`)        | Selected host credential (`host`)     |
| Task input             | Interactive session                      | `--prompt` or `--prompt-file`         |
| Default timeout        | No task timeout                          | 600 seconds                           |

Both default to Pi. Add `--agent opencode` to select OpenCode.

## Work interactively

```sh
./pi-pod dev /path/to/your-project
./pi-pod dev /path/to/your-project --agent opencode
```

The agent edits the supplied directory directly, including uncommitted work. Exit through the agent's normal UI when finished (for Pi, `/quit`).

By default, Pi uses your host `openai-codex` credential and OpenCode uses your host `openai` credential. To use a supported API-token source instead, choose a [profile](authentication.md#api-token-profiles). Interactive Pi can also load [selected read-only host extensions](agents.md#interactive-pi-extensions).

## Run a headless task

Start with a clean Git repository. The local CLI stages the selected native host credential by default:

```sh
./pi-pod run /path/to/your-project --prompt "Fix the failing unit tests"
```

A supported API-token profile is an explicit alternative. Create it through a no-echo terminal prompt, then select it with the same agent:

```sh
./pi-pod auth profile create --agent opencode --provider anthropic --profile worker
./pi-pod run /path/to/your-project --agent opencode --auth worker --prompt "Fix the failing unit tests"
```

See [supported authentication](agents.md#authentication-identifiers) for the intentionally restricted compatibility matrix.

For a longer task, put the instructions in a file and optionally adjust the timeout. Prompt-file paths are relative to your calling directory, not the target project:

```sh
./pi-pod run /path/to/your-project --agent opencode --auth worker --prompt-file /path/to/task.md --timeout 1200
```

Use exactly one of `--prompt` and `--prompt-file`. To use the selected host credential explicitly instead of a profile:

```sh
./pi-pod run /path/to/your-project --auth host --prompt "Summarize the repository"
```

Local CLI headless work defaults to the selected agent's narrowly staged host credential. Use `--auth worker` to select an API-token profile, or `--auth host` explicitly. The public library has a different profile-only headless contract; see [authentication](authentication.md).

### Review and remove the result

At the end of a launched clone run, the CLI prints `Retained clone <run-id>: <path>`. The clone stays available even after an agent error or timeout. Use the printed path to inspect it:

```sh
git -C /path/to/retained/workspace status --short
git -C /path/to/retained/workspace diff
git -C /path/to/retained/workspace log -5 --oneline
```

Review new files and any agent-created commits as well as the working-tree diff. pi-pod does not copy changes back, commit, push, or open a PR; you choose how to keep the work. When you no longer need the clone:

```sh
./pi-pod remove <run-id>
```

Only remove it after saving anything you want to keep. Removal checks are described below.

## Workspace modes

`dev` defaults to `bind`: the agent modifies the supplied folder directly. It may be dirty, but pi-pod never commits, resets, copies back, or removes it. Linked Git worktrees are rejected.

`run` defaults to `clone`: pi-pod requires a clean normal Git repository and clones local `HEAD` into wrapper-owned state. Committed but unpushed work is included; uncommitted, ignored, and untracked files are not. Every clone that reaches agent startup is retained under `$XDG_STATE_HOME/pi-pod/runs/<run-id>/workspace` (or `~/.local/state/pi-pod/runs/<run-id>/workspace`) until explicitly removed.

Override the default with `--workspace`. For example, to run a task directly in a directory that isn't a clean Git repository:

```sh
./pi-pod run /path/to/your-project --workspace bind --agent opencode --auth worker --prompt "Explain this project"
```

Bind mode allows direct edits even if your prompt only asks for an explanation. `remove` refuses while the exact run container or its preparation reservation exists. It never removes a bind workspace. See [authentication staging and cleanup](authentication.md) for credential-stage behavior.

## Workspace dependencies and toolchains

pi-pod does not select a package manager or install project dependencies. The shared image includes Bun and Node/npm, but it does not promise Yarn, pnpm, Corepack, language-specific build tools, or a project's full toolchain. Use an audited compatible `--image` when the project needs additional tools.

A bind workspace exposes its existing files, including `node_modules`, to the container. Those dependencies are not guaranteed to run in the image: native modules and generated binaries must match the Linux container architecture. A clone contains only committed source, so ignored or untracked dependencies are absent and must be installed in the retained clone. Such installation can modify a bind workspace, consumes its workspace/storage budget, and requires network access unless dependencies are already available in the image or workspace.

pi-pod does not mount host package caches, package-manager configuration, or private-registry credentials. `--network none` therefore prevents a fresh dependency install. macOS is not currently supported; a future Podman Machine implementation must treat macOS-built dependencies as incompatible with its Linux guest until verified and reinstalled there.

## Options and passthrough

Use `./pi-pod --help` or `./pi-pod run --help` for command help. Common options:

```text
--agent pi|opencode
--workspace bind|clone
--auth host|<profile>              selected source; defaults to per-agent CLI source then host
--image IMAGE
--config /absolute/path.json        agent/mode preferences and Pi dev package selections
--no-config                        dev only; skip this config layer (legacy host extensions still apply)
--prompt TEXT                      run only; task instructions
--prompt-file PATH                 run only; read task instructions from a file
--timeout SECONDS                  run only; defaults to 600
--network pasta|none
--relabel-workspace
--memory SIZE --cpus N --pids N
--workspace-bytes N --temporary-bytes N
-- <agent-specific arguments>
```

Only `dev` and `run` accept tokens after `--`; they are passed to the selected container agent unchanged. For example, select a model for this session (replace `your-model-id` with a model available to your provider):

```sh
./pi-pod dev /path/to/your-project -- --provider openai-codex --model your-model-id --thinking high
./pi-pod dev /path/to/your-project --agent opencode -- --model openai/your-model-id
```

Native `--provider`/`--model`/`--thinking` (Pi) and `--model`/`-m`/`--variant` (OpenCode) override their matching preference-file fields without a duplicate flag. Invalid wrapper flags are rejected before workspace, auth, or Podman side effects. See [model preferences](configuration.md) to save defaults instead of repeating flags.

`--network none` is useful for local inspection. Remote model providers need the default `pasta` network. The default limits are 4 GiB memory, 4 CPUs, 512 processes, 4 GiB workspace monitoring, and 512 MiB each for `/tmp` and the container home. Monitoring is not a hard aggregate disk quota.

Use `--relabel-workspace` only after deciding that recursive SELinux relabeling is appropriate for that bind directory. Wrapper-owned clones and staging directories receive private relabeling automatically.

## Troubleshooting

- **Prerequisites:** pi-pod requires native Linux x64, local rootless Podman, cgroup v2 controllers, and sometimes `systemd-run --user` for a delegated terminal scope. See [installation](installation.md#requirements).
- **Image:** run `./pi-pod build` from the bundle directory; launches never pull or build an image automatically. Compiling the CLI does not build the agent image.
- **Entrypoint:** use the compiled `pi-pod` executable with its adjacent `container/` directory. If Podman or Git is not found, check [tool locations](installation.md#use-it-with-your-project). Contributors using the source launcher can consult [development](development.md#source-launcher).
- **Authentication:** see [authentication.md](authentication.md). Do not delete state broadly; use the named recovery command only after its diagnostic says the stage is safe to recover or discard.
- **Workspace:** clone mode requires clean local Git history; use `--workspace bind` for a dirty human checkout.
- **Dependencies:** a clone does not include ignored `node_modules` or other untracked dependencies. See [workspace dependencies](#workspace-dependencies-and-toolchains).
- **Execution and cleanup:** a retained clone is normal after a launched clone run. An unverified-cleanup diagnostic, retained preparation reservation, or interrupted auth stage requires recovery; follow the diagnostic rather than removing state manually.
