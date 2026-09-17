# Development

## Runtime and commands

This checkout pins Bun 1.3.14 in `.mise.toml`.

```sh
mise exec -- bun install
mise exec -- bun test
mise exec -- bun run format:check
mise exec -- bun run typecheck
mise exec -- ./bin/pi-pod build
git diff --check
```

If Mise is unavailable in a pi-pod worker, first verify `bun --version` matches the pin, then use that Bun directly. Use Bun, not Node, npm, pnpm, or yarn. Format intentionally with `bun run format`; `bun run format:check` never rewrites files. Prettier is development-only; no hooks or editor settings are installed. Invoke the source CLI through `./bin/pi-pod`; do not execute `src/cli.ts` from an untrusted workspace.

Opt-in integration tests require the relevant local Podman/user-systemd setup:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Tests use temporary fake credentials and fixtures. Never make personal configuration, OAuth, paid model requests, or provider tokens a normal dependency.

## Source map and reading order

1. `src/cli/bootstrap.ts` and `bin/pi-pod`: trusted host startup boundary.
2. `src/cli/`: syntax and command composition.
3. `src/execution/`: public run/login orchestration, policy, prompt staging, and outcomes.
4. `src/auth/`: auth policy, selected-provider storage, staging, locks, and recovery.
5. `src/workspace/` and `src/state/`: preparation, retained ownership/removal, and wrapper state policy.
6. `src/container/` and `src/resources/`: hardened argv, lifecycle, limits, and storage enforcement.

See [architecture.md](architecture.md) for dependency and lifecycle tables.

## Adding an agent: proposal checklist

No third agent is approved by this checklist. A future, separately reviewed integration must pin a concrete image version; document executable path, licenses, modes, prompt/exit/cancellation behavior, native state locations, credential/provider shapes, host-auth capability (if any), discovery/permission behavior, and image cost. It must prove startup under the existing rootless/read-only/capability/resource policy without broadening it. Add shared contract tests plus agent-specific tests and docs; unsupported capabilities must fail early. Do not add a plugin loader, arbitrary executable configuration, host installers, broad mounts, or automatic image discovery.

When upgrading Pi, OpenCode, Bun, or the image base, update the auditable `container/Containerfile`, image/docs version references, and native credential/argv compatibility tests together.
