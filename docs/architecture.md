# Architecture

## Dependency direction

```text
CLI / trusted library input
  -> policy/default resolution
  -> selected agent behavior and validated credentials
  -> workspace, auth, prompt, and dev-resource preparation
  -> hardened Podman argv -> shared lifecycle -> guarded finalization
```

The agent contributes only native command/state behavior. pi-pod owns execution policy: workspace ownership, mounts, environment, network, limits, lifecycle, and cleanup. An agent integration must not supply arbitrary Podman arguments, host commands, mounts, or installers.

## Current source responsibilities

| Area | Responsibility |
| --- | --- |
| `bin/pi-pod`, `src/cli/bootstrap.ts` | Trusted Bun bootstrap before interpreting a target workspace. |
| `src/cli/` | Crust syntax, early CLI validation, signals, help, and delegated scope entry. |
| `src/run.ts`, `src/login.ts` | Run and profile-login orchestration, explicit cleanup ordering, public outcomes. |
| `src/agents.ts` | Current Pi/OpenCode native launch, prompt, and login differences. |
| `src/run/credentials.ts`, `src/auth/` | Mode/auth policy; selected-provider profiles, host reads, locks, stages, recovery. |
| `src/workspace/` | Bind/clone policy, controlled Git operations, retained-run reservations/removal. |
| `src/podman.ts`, `src/container/` | Mount/environment policy, hardening argv, preflight, container ownership. |
| `src/dev-resources.ts` | Pi-only filtered interactive development resources. |

## Lifecycle ownership

| Outcome | Bind/clone workspace | Auth stage and lock | Prompt/Pi resource stage |
| --- | --- | --- | --- |
| Success | Bind remains caller-owned; launched clone is retained and reservation released | Reconcile profile or discard host source-only stage; release profile lock | Remove after verified container removal |
| Agent nonzero exit | Same as success | Same as success | Same as success |
| Abort/timeout | Same after exact container removal | Same after exact container removal | Same after exact container removal |
| Setup failure before launch | Bind untouched; exclusively acquired clone preparation is discarded | Do not retain completed stage; release acquired lock | Remove staged files |
| Container removal fails | Bind untouched; clone/reservation retained | Retain stage and profile lock; do not reconcile | Retain staged data |
| Reconciliation fails | Workspace outcome unchanged | Retain private stage; report recovery requirement | Already removed only after container removal |

The container-removal barrier precedes reconciliation, stage deletion, lock release, and clone-reservation release because an existing container could still be writing or mounting those resources.
