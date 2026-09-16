# AGENTS.md

## Project

`pi-pod` is a Bun TypeScript CLI/library that runs Pi or OpenCode in rootless Podman. It is a security boundary for local development and autonomous runs, not an orchestrator, daemon, or deployment platform.

Read `README.md` before changing behavior. The plans in `plans/` and adversarial constraints in `reviews/` document security decisions that should not be silently weakened.

## Commands

Use the repository-pinned Bun runtime:

```sh
mise exec -- bun install
mise exec -- bun test
mise exec -- bun run typecheck
mise exec -- ./bin/pi-pod build
```

Run opt-in integration tests only when Podman/the required user-systemd environment is available:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Use Bun, not Node, npm, pnpm, or yarn. Invoke the CLI through `./bin/pi-pod`, not `src/cli.ts` from an untrusted workspace: the launcher protects against workspace-controlled Bun configuration.

## Layout

- `index.ts` — public library exports.
- `src/cli/` — parsing, commands, signals, output, and delegation.
- `src/run.ts`, `src/podman.ts` — agent execution and restrictive Podman arguments.
- `src/auth/` — profiles, host credential validation/staging, locking, and recovery.
- `src/workspace/` — direct/clone workspace preparation and retained-run lifecycle.
- `src/dev-resources.ts` — filtered, read-only interactive Pi extension/package resources.
- `container/Containerfile` — pinned agent image.
- `src/**/*.test.ts` — unit and adversarial regression tests.

## Security invariants

- `dev` may stage only the narrowly selected host Codex credential and approved, read-only Pi development resources. It must never write host Pi state back.
- Headless `run` and library-autonomous use must never read or mount host Pi credentials, settings, extensions, sessions, skills, analytics, or shell configuration. They use a pi-pod profile or explicitly named API-key variables.
- Do not add broad host mounts, Podman socket access, SSH/Git credential forwarding, proxy forwarding, arbitrary Podman options, or credential values in argv, logs, diagnostics, tests, or docs.
- Preserve rootless Podman, dropped capabilities, `no-new-privileges`, read-only image root, resource limits, workspace isolation, and guarded retained-run deletion unless an explicit security decision and regression tests justify a change.
- Treat bind workspaces as untrusted and potentially destructive. Do not copy changes back, commit, push, publish, or remove caller-owned workspaces automatically.
- Do not change host shell files, tmux sessions, desktop configuration, or wrappers without explicit user approval.

## Change discipline

- Keep security-sensitive code small, explicit, and covered by focused tests.
- Add or update tests for credential policy, mount/environment allowlists, lifecycle cleanup, and filesystem ownership checks whenever related behavior changes.
- Run relevant tests, `mise exec -- bun run typecheck`, and `git diff --check` before reporting completion.
- Update `README.md` when CLI behavior, image versions, defaults, credential policy, or security guarantees change.
- Do not commit, amend, create branches, configure remotes, or push unless the user explicitly asks.

## Distribution

The source is public but the package remains private to prevent registry publication. It is source-available under Apache-2.0 with Commons Clause; see `LICENSE`. Do not describe it as OSI open source or remove the Commons Clause without explicit authorization.
