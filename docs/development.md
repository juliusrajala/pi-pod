# Development

For installation and your first session, start with [installation](installation.md) and [usage](usage.md). This guide covers contributing, testing, and producing release bundles.

## Runtime and commands

Use your normally installed Bun (1.3.14 or later) and rootless Podman. Mise is optional; the scripts neither discover runtimes through it nor install a private Bun.

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run format:check
bun run typecheck
git diff --check
```

`bun run build` compiles current source, verifies the bundle, builds its matching image, and updates `./pi-pod` to that completed build. Repeat it after changes; the version need not change. Podman reuses cached layers. Use Bun, not Node, npm, pnpm, or yarn. Format intentionally with `bun run format`; `bun run format:check` never rewrites files. Prettier is development-only; no hooks or editor settings are installed.

## Source launcher

For everyday use, run the [compiled CLI](installation.md) through `./pi-pod`. While changing pi-pod itself, run the source without recompiling:

```sh
bun run dev --help
bun run dev dev /path/to/your-project
```

The first `dev` is the package script (run source); the second is the CLI subcommand (interactive agent session). Source changes take effect on the next invocation. Image changes still require `bun run build`. The internal `scripts/dev-launcher` also supports linked packages and invocation from another directory.

Run package scripts from the trusted checkout. The source launcher resolves installed Bun on PATH from that checkout and rejects a Bun executable inside the target workspace before probing it. It starts Bun with a synthetic startup HOME, disables dotenv loading, then restores the caller's HOME and working directory. Do not execute `src/cli.ts` directly from an untrusted workspace. PATH must identify a trusted installed Bun; the compiled CLI avoids this source-runtime lookup entirely.

For nonstandard installations, set these variables only to explicitly trusted absolute paths:

| Variable              | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `PI_POD_BUN_PATH`     | The Bun executable to use (1.3.14 or later).                        |
| `PI_POD_TRUSTED_PATH` | A trusted tool directory, for example one containing Podman or Git. |

After selecting Bun, host-tool PATH is restricted to system locations and the explicit trusted-tool override. Linked/local Bun packages use this same launcher. See [architecture](architecture.md#host-startup-paths) for the startup boundary.

## Release bundle

The normal `bun run build` includes release compilation and verification. For distribution tooling that intentionally needs only a portable bundle, the lower-level commands remain available from the repository root:

```sh
bun run build:release -- --target linux-x64
bun run verify:release -- dist/pi-pod-0.3.1-linux-x64
```

The bundle contains `pi-pod`, the audited `container/Containerfile` and locked image dependency files, `README.md`, and `SHA256SUMS`. Verify the checksums before copying or running it. The compiled executable is the host controller and still requires rootless Podman, cgroup v2, and a locally built image (`./pi-pod build`); it is not a Pi/OpenCode runtime. The source launcher remains the contributor and local-package entrypoint; installed packages expose both `pi-pod` and the legacy `pi-pod-dev` alias, and the launcher refuses caller-workspace Bun paths. Compilation explicitly disables Bun dotenv, bunfig, tsconfig, and package.json autoloading; compilation alone is not the security guarantee.

Do not build or advertise macOS, Windows, or Linux arm64 artifacts. Arm64 needs a separately validated image, Bun asset, and Podman smoke test.

## Integration and provider validation

Opt-in integration tests require the relevant local Podman/user-systemd setup:

```sh
PI_POD_INTEGRATION=1 bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 bun test src/cli/delegation.integration.test.ts
```

Tests use temporary fake credentials and fixtures. Never make personal configuration, OAuth, paid model requests, or provider tokens a normal dependency.

The normal suite does not access provider accounts, personal configuration, real repositories, or forge credentials. Supported API-token profile validation uses generated fake values only. Any real provider workflow is opt-in and must never record a token or provider response.

## Source map and reading order

1. `src/cli/bootstrap.ts` and `scripts/dev-launcher`: trusted host startup boundary.
2. `src/cli/`: syntax and command composition.
3. `src/execution/`: run orchestration, policy, prompt staging, and outcomes.
4. `src/auth/`: API-token profile/default storage, selected host staging, and recovery.
5. `src/workspace/` and `src/state/`: preparation, retained ownership/removal, and wrapper state policy.
6. `src/container/` and `src/resources/`: hardened argv, lifecycle, limits, and storage enforcement.

See [architecture.md](architecture.md) for dependency and lifecycle tables.

## Adding an agent: proposal checklist

No third agent is approved by this checklist. A future, separately reviewed integration must pin a concrete image version; document executable path, licenses, modes, prompt/exit/cancellation behavior, native state locations, credential/provider shapes, host-auth capability (if any), discovery/permission behavior, and image cost. It must prove startup under the existing rootless/read-only/capability/resource policy without broadening it. Add shared contract tests plus agent-specific tests and docs; unsupported capabilities must fail early. Do not add a plugin loader, arbitrary executable configuration, host installers, broad mounts, or automatic image discovery.

When upgrading Pi, OpenCode, Bun, or the image base, update the auditable `container/Containerfile`, image/docs version references, and native credential/argv compatibility tests together.
