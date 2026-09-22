# AGENTS.md

## Project

`pi-pod` is a Bun TypeScript CLI/library that runs Pi or OpenCode in rootless Podman. It is a security boundary for local development and autonomous runs, not an orchestrator, daemon, or deployment platform.

Read `README.md` before changing behavior. Maintained contributor and security guidance lives in `docs/development.md` and `docs/security.md`; [the plans index](plans/README.md) and adversarial constraints in `reviews/` preserve decisions that should not be silently weakened.

## Commands

Use the repository-pinned Bun runtime:

```sh
mise exec -- bun install
mise exec -- bun test
mise exec -- bun run typecheck
mise exec -- ./scripts/dev-launcher build
```

Run opt-in integration tests only when Podman/the required user-systemd environment is available:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Use Bun, not Node, npm, pnpm, or yarn. The development launcher is `./scripts/dev-launcher`; do not invoke `src/cli.ts` from an untrusted workspace, because the launcher protects against workspace-controlled Bun configuration. Normal local use goes through the compiled release bundle.

## Layout

- `index.ts` — public library exports.
- `src/cli/` — parsing, commands, signals, output, and delegation.
- `src/execution/` — run orchestration, policy, prompt staging, and finalization.
- `src/container/` — restrictive Podman arguments, preflight, and lifecycle.
- `src/auth/` — API-token profiles/defaults, host credential validation/staging, and guarded recovery.
- `src/workspace/` — direct/clone preparation and retained-run lifecycle/removal.
- `src/agents/pi/dev-resources.ts` — filtered, read-only interactive Pi extension/package resources.
- `container/Containerfile` — pinned agent image.
- `src/**/*.test.ts` — unit and adversarial regression tests.

## Security invariants

- Local CLI `dev` and `run` may stage only the selected native host credential (Pi `openai-codex`, OpenCode `openai`) or an explicitly selected pi-pod API-token profile. They must never mount a host auth directory or write host/profile state back.
- Public headless library use requires an explicit pi-pod API-token profile and must never read or mount host Pi/OpenCode credentials, CLI defaults, settings, extensions, sessions, skills, analytics, shell configuration, or arbitrary API-key environment variables.
- Do not add broad host mounts, Podman socket access, SSH/Git credential forwarding, proxy forwarding, arbitrary Podman options, or credential values in argv, logs, diagnostics, tests, or docs.
- Preserve rootless Podman, dropped capabilities, `no-new-privileges`, read-only image root, resource limits, workspace isolation, and guarded retained-run deletion unless an explicit security decision and regression tests justify a change.
- Treat bind workspaces as untrusted and potentially destructive. Do not copy changes back, commit, push, publish, or remove caller-owned workspaces automatically.
- Do not change host shell files, tmux sessions, desktop configuration, or wrappers without explicit user approval.

## Change discipline

- Keep security-sensitive code small, explicit, and covered by focused tests.
- Add or update tests for credential policy, mount/environment allowlists, lifecycle cleanup, and filesystem ownership checks whenever related behavior changes.
- Run `bun run format:check`, relevant tests, `mise exec -- bun run typecheck`, and `git diff --check` before reporting completion. Formatting is explicit (`bun run format`); do not install hooks or change editor settings.
- Update `README.md` when CLI behavior, image versions, defaults, credential policy, or security guarantees change.
- Do not commit, amend, create branches, configure remotes, or push unless the user explicitly asks.

## Distribution

The source is public but the package remains private to prevent registry publication. It is source-available under Apache-2.0 with Commons Clause; see `LICENSE`. Do not describe it as OSI open source or remove the Commons Clause without explicit authorization.
