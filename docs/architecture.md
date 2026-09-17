# Architecture

## Host startup paths

Source checkouts and linked/local packages use `scripts/dev-launcher`. It starts the pinned Bun runtime from the trusted package root, disables source-launcher autoloading, then restores the caller cwd and HOME before command routing. Linux x64 release bundles use their compiled `pi-pod` executable directly; the compiled entrypoint preserves the caller context and uses its own absolute executable path for delegated user scopes. Its build flags explicitly disable Bun dotenv, bunfig, tsconfig, and package.json autoloading.

Both paths enter the same `src/cli/app.ts` command tree and domain operations. A release `build` resolves only the regular, audited `container/Containerfile` beside the executable; source mode resolves the checkout recipe. The compiled host controller does not contain the agent image or replace rootless Podman containment.

## Directory map and dependency direction

```text
cli / trusted library input
  -> config + execution policy
  -> agents, auth, workspace, prompt/resources
  -> container args + lifecycle
  -> execution finalization and outcome
```

`utils/` has no domain policy. `state/` owns wrapper control paths and guarded deletion. `resources/` owns limits and storage monitoring. Agent adapters describe native behavior only; they do not launch host commands or supply Podman policy. `container/` owns the visible hardened argv, mounts, environment forwarding, preflight, and lifecycle. `execution/` composes domains; `cli/` adapts user input and never supplies policy to lower domains.

## Task-oriented index

| Question                                      | Start here                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| How does a run work?                          | `src/execution/run.ts`                                                 |
| Where do defaults/source selection come from? | `src/execution/policy.ts`, `src/config/`                               |
| How do I add an agent?                        | `src/agents/contract.ts`, `src/agents/registry.ts`                     |
| Which native configuration is permitted?      | `src/config/load.ts`, selected agent definition                        |
| What crosses the container boundary?          | `src/container/args.ts`, `src/container/lifecycle.ts`                  |
| Who owns credentials/recovery?                | `src/auth/staging.ts`, `src/auth/lock.ts`, `src/auth/recovery.ts`      |
| Can this directory be deleted?                | `src/workspace/remove.ts`, `src/workspace/runs.ts`, `src/state/`       |
| Where are budgets enforced?                   | `src/resources/limits.ts`, `src/resources/storage.ts`                  |
| How does host startup remain safe?            | `scripts/dev-launcher`, `src/cli/bootstrap.ts`, `src/workspace/git.ts` |

The package-root `index.ts` is the stable public library surface. `src/cli.ts` is the only root runtime source file and remains the trusted launcher target. Internal modules import owners directly; there are no legacy root facades.

## Lifecycle ownership

The visible run sequence is resolve/validate → prepare → stage → execute → establish cleanup evidence → finalize owned resources → return outcome. Container removal is established before credential reconciliation, stage deletion, lock release, or clone-reservation release because a live container may still write or mount those resources.

| Outcome                                     | Workspace                                   | Auth/resource stages                                  |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| Success/nonzero/abort/timeout after removal | Bind untouched; clone retained and released | Reconcile profile or discard host stage, then cleanup |
| Setup failure before launch                 | Bind untouched; acquired clone discarded    | Release acquired resources                            |
| Removal or reconciliation failure           | Clone/reservation retained                  | Retain private stage and report recovery requirement  |

Layout/dependency rules are reviewed manually with this map at migration changes; this project intentionally has no architecture-policing toolchain.
