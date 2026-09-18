# Development

## Runtime and commands

This checkout pins Bun 1.3.14 in `.mise.toml`.

```sh
mise exec -- bun install
mise exec -- bun test
mise exec -- bun run format:check
mise exec -- bun run typecheck
mise exec -- ./scripts/dev-launcher build
git diff --check
```

If Mise is unavailable in a pi-pod worker, first verify `bun --version` matches the pin, then use that Bun directly. Use Bun, not Node, npm, pnpm, or yarn. Format intentionally with `bun run format`; `bun run format:check` never rewrites files. Prettier is development-only; no hooks or editor settings are installed. Invoke the source CLI through `./scripts/dev-launcher`; do not execute `src/cli.ts` from an untrusted workspace. The launcher does not inherit caller PATH entries; use explicit absolute `PI_POD_BUN_PATH` or `PI_POD_TRUSTED_PATH` only for trusted installations.

## Release bundle

The supported release target is currently Linux x64 only. From the canonical repository root, a pinned Bun can produce the bundle:

```sh
mise exec -- bun run build:release -- --target linux-x64
mise exec -- bun run verify:release -- dist/pi-pod-linux-x64
```

The bundle contains `pi-pod`, the audited `container/Containerfile` and locked image dependency files, `README.md`, and `SHA256SUMS`. Verify the checksums before copying or running it. The compiled executable is the host controller and still requires rootless Podman, cgroup v2, and a locally built image (`./pi-pod build`); it is not a Pi/OpenCode runtime. The source launcher remains the contributor and local-package entrypoint; installed packages expose both `pi-pod` and the legacy `pi-pod-dev` alias, and the launcher refuses caller-workspace Bun paths. Compilation explicitly disables Bun dotenv, bunfig, tsconfig, and package.json autoloading; compilation alone is not the security guarantee.

Do not build or advertise macOS, Windows, or Linux arm64 artifacts. Arm64 needs a separately validated image, Bun asset, and Podman smoke test.

Opt-in integration tests require the relevant local Podman/user-systemd setup:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Tests use temporary fake credentials and fixtures. Never make personal configuration, OAuth, paid model requests, or provider tokens a normal dependency.

## Source map and reading order

1. `src/cli/bootstrap.ts` and `scripts/dev-launcher`: trusted host startup boundary.
2. `src/cli/`: syntax and command composition.
3. `src/execution/`: public run/login orchestration, policy, prompt staging, and outcomes.
4. `src/auth/`: auth policy, selected-provider storage, staging, locks, and recovery.
5. `src/workspace/` and `src/state/`: preparation, retained ownership/removal, and wrapper state policy.
6. `src/container/` and `src/resources/`: hardened argv, lifecycle, limits, and storage enforcement.

See [architecture.md](architecture.md) for dependency and lifecycle tables.

## Adding an agent: proposal checklist

No third agent is approved by this checklist. A future, separately reviewed integration must pin a concrete image version; document executable path, licenses, modes, prompt/exit/cancellation behavior, native state locations, credential/provider shapes, host-auth capability (if any), discovery/permission behavior, and image cost. It must prove startup under the existing rootless/read-only/capability/resource policy without broadening it. Add shared contract tests plus agent-specific tests and docs; unsupported capabilities must fail early. Do not add a plugin loader, arbitrary executable configuration, host installers, broad mounts, or automatic image discovery.

When upgrading Pi, OpenCode, Bun, or the image base, update the auditable `container/Containerfile`, image/docs version references, and native credential/argv compatibility tests together.
