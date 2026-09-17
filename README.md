# pi-pod

Run Pi or OpenCode in a rootless Podman container with one writable project mount. pi-pod is a Bun library and CLI for local/self-hosted use. It owns workspace preparation, selected credential staging, Podman restrictions, cancellation, and retained clones. It does **not** commit, push, open pull requests, copy changes back, run a daemon, or act as an orchestrator.

Source is public at [github.com/juliusrajala/pi-pod](https://github.com/juliusrajala/pi-pod); it is source-available under [Apache-2.0 with Commons Clause](#license). The package remains private: registry publication is not a v0.1 goal.

## Requirements and installation

- Linux with local **rootless** Podman, cgroup v2 resource limits, and `systemd-run --user` when a terminal scope does not delegate CPU control.
- Bun 1.3.14 or later; this checkout pins 1.3.14 in `.mise.toml`.
- Git for clone mode.

```sh
git clone https://github.com/juliusrajala/pi-pod.git
cd pi-pod
bun install
./bin/pi-pod build
./bin/pi-pod --help
```

The shared `localhost/pi-pod:0.1.0` image contains Pi 0.85.1, OpenCode 1.18.27, Bun 1.3.14, Node, Git, Bash, `fd`, and ripgrep. It currently targets `linux/amd64`. The build pins its Node base digest and validates Bun's download checksum.

From a source checkout, always invoke `./bin/pi-pod`, not `src/cli.ts` from an untrusted workspace. The launcher starts Bun from the trusted package directory, disables automatic `.env` loading, and restores the caller directory before interpreting a workspace path. For a linked/installed package, use `pi-pod`. A local Bun consumer can use `bun add /path/to/pi-pod` with Bun 1.3.14 or later.

## Start here

```sh
# Interactive development: direct writable folder.
./bin/pi-pod dev .
./bin/pi-pod dev . --agent opencode

# Headless work: a clean local-HEAD clone, retained for review.
./bin/pi-pod run . --prompt "Fix the failing unit tests"

# Explicit task API key; values stay in the Podman client environment, not argv.
./bin/pi-pod run . --auth none --env ANTHROPIC_API_KEY --prompt "Summarize the repository"
```

`dev` defaults to `bind` and `run` defaults to `clone`. A bind workspace can be dirty and is never removed, reset, committed, or copied by pi-pod. Clone mode requires a clean normal Git repository and includes local committed (even unpushed) `HEAD`, but not uncommitted, ignored, or untracked files. Every clone that reaches agent startup is retained under `$XDG_STATE_HOME/pi-pod/runs/<run-id>/workspace`; review it, then remove it explicitly:

```sh
./bin/pi-pod remove <run-id>
```

The removal command refuses while the exact run container or preparation reservation remains.

## Credentials: development and autonomous work

Interactive `dev` defaults to `--auth host`. Pi stages only the `openai-codex` credential from `~/.pi/agent/auth.json`; OpenCode stages only the `openai` credential from `$XDG_DATA_HOME/opencode/auth.json` (or the standard home fallback). Each session receives a fresh private stage, so concurrent host-auth dev sessions are supported. Staging is private, no host agent directory is mounted, and pi-pod never writes the staged credential back.

Interactive Pi dev also loads trusted Pi extensions by default: the direct extension directory and local package roots declared in host settings are mounted read-only, and pi-pod generates filtered settings containing only package declarations and Pi model defaults. It does not mount general settings, sessions, skills, themes, analytics, credentials, or remote package sources. Pass `-- --no-extensions` to Pi to disable them.

Headless `run` and library-autonomous use never read host Pi/OpenCode credentials, settings, extensions, sessions, skills, analytics, or shell configuration. `run` rejects `--auth host` before workspace, state, or Podman side effects. It uses the pi-pod-owned `default` profile unless `--auth none` is explicit.

```sh
./bin/pi-pod login --agent pi --provider openai-codex --profile worker
./bin/pi-pod login --agent opencode --provider <provider-id> --profile worker
```

Profiles persist only selected native provider credentials below `$XDG_STATE_HOME/pi-pod/auth/` (or `~/.local/state/pi-pod/auth/`). One container uses a profile at a time. For recovery of a private interrupted stage, use the named command only after its diagnostic confirms that the recorded container is gone:

```sh
./bin/pi-pod auth recover --agent pi --profile worker
./bin/pi-pod auth discard --agent pi --profile worker
./bin/pi-pod auth unlock --agent pi --profile worker
```

## Container boundary

Each run uses rootless Podman with keep-id mapping, dropped capabilities, `no-new-privileges`, a read-only image root, default seccomp/SELinux separation, private namespaces, and memory/CPU/process/storage monitoring. Writable locations are `/workspace`, bounded `/tmp`, and bounded container home. There is no Podman socket, host networking, published port, proxy forwarding, SSH agent, host home, parent-project mount, or arbitrary Podman-option escape hatch.

This is containment, not a sealed vault: a bind mount lets an agent modify visible project files (including `.env` files), repository code can read any credential supplied to it, `pasta` is not an egress allowlist, storage monitoring is not a hard quota, and containers share the host kernel.

## Documentation

The root README is an entry point; maintained details live in [docs/](docs/README.md):

- [Usage, options, and troubleshooting](docs/usage.md)
- [Pi/OpenCode support matrix](docs/agents.md)
- [Authentication, recovery, and lifecycle outcomes](docs/authentication.md)
- [Model preference configuration (D1) and deferred resource selections](docs/configuration.md)
- [Architecture and lifecycle ownership](docs/architecture.md)
- [Library API](docs/library.md)
- [Development guide](docs/development.md)
- [Security guarantees and limits](docs/security.md)

## Required manual OAuth validation for autonomous profiles

This cannot run in CI and must never expose a token. After building the image, use a disposable empty directory and named profile:

1. Run `./bin/pi-pod login --agent pi --provider openai-codex --profile v01-check` and complete Pi's device-code flow. Exit with `/quit`.
2. In a fresh process, run `./bin/pi-pod run /path/to/empty-dir --workspace bind --auth v01-check --prompt "Reply only: AUTH_OK" --timeout 60`; confirm it does not ask to log in again.
3. Repeat after provider refresh/expiry timing permits.
4. For every intended OpenCode subscription provider, repeat with `--agent opencode --provider <provider-id>`.

Record only provider name, command exit status, and whether reuse/refresh succeeded. Do not inspect, print, or copy tokens, device codes, or redirect URLs.

## Test

```sh
bun test
bun run typecheck
git diff --check
```

The normal suite uses temporary Git/auth fixtures and does not access provider accounts, personal configuration, real repositories, or forge credentials. Podman/systemd integration tests are opt-in; see [development.md](docs/development.md).

## License

pi-pod is source-available under the Apache License 2.0 with the Commons Clause License Condition v1.0. You may use, modify, and redistribute it subject to those terms; the license does not grant the right to sell software or services whose value derives entirely or substantially from pi-pod. See [LICENSE](LICENSE).
