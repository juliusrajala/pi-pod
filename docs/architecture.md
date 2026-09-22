# Architecture

## Host startup paths

Everyday use goes through the compiled `pi-pod` executable in a Linux x64 bundle. The compiled entrypoint preserves the caller context and uses its own absolute executable path for delegated user scopes. Its build flags explicitly disable Bun dotenv, bunfig, tsconfig, and package.json autoloading.

Contributor source runs and linked/local packages use `scripts/dev-launcher`. It starts a supported Bun runtime from the trusted package root, disables source-launcher autoloading, then restores the caller cwd and HOME before command routing. See [installation](installation.md) for compiled bundle setup and [development](development.md#source-launcher) for the source launcher.

Both paths enter the same `src/cli/app.ts` command tree and domain operations. A release `build` resolves only the regular, audited `container/Containerfile` beside the executable; source mode resolves the checkout recipe. The compiled host controller does not contain the agent image or replace rootless Podman containment.

## Directory map and dependency direction

```text
cli / trusted library input
  -> config + execution policy
  -> agents, auth, workspace, prompt/resources
  -> container args + lifecycle
  -> execution finalization and outcome
```

The intended boundary keeps `utils/` domain-neutral and puts wrapper control paths and guarded deletion in `state/`. That separation is not yet complete: state-root and deletion policy still live in `src/utils/fs.ts`. Resource validation and monitoring live in `resources/`, while resource defaults and the headless timeout still live in `container/image.ts`. See [Plan 05's current checkpoint](plans/05-domain-layout-and-navigation.md#current-checkpoint) for the remaining ownership and dependency work.

Agent adapters describe native behavior only; they do not launch host commands or supply Podman policy. `container/` owns the visible hardened argv, mounts, environment forwarding, preflight, and lifecycle. `execution/` composes domains; `cli/` adapts user input.

## Task-oriented index

| Question                                      | Start here                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| How does a run work?                          | `src/execution/run.ts`                                                 |
| Where do defaults/source selection come from? | `src/execution/policy.ts`, `src/config/`                               |
| How do I add an agent?                        | `src/agents/contract.ts`, `src/agents/registry.ts`                     |
| Which native configuration is permitted?      | `src/config/load.ts`, selected agent definition                        |
| What crosses the container boundary?          | `src/container/args.ts`, `src/container/lifecycle.ts`                  |
| Who owns credentials/recovery?                | `src/auth/profiles.ts`, `src/auth/defaults.ts`, `src/auth/staging.ts`  |
| Can this directory be deleted?                | `src/workspace/remove.ts`, `src/workspace/runs.ts`, `src/utils/fs.ts`  |
| Where are budgets enforced?                   | `src/resources/limits.ts`, `src/resources/storage.ts`                  |
| How does host startup remain safe?            | `scripts/dev-launcher`, `src/cli/bootstrap.ts`, `src/workspace/git.ts` |

The package-root `index.ts` is the stable public library surface. `src/cli.ts` is the only root runtime source file and remains the trusted launcher target. Internal modules import owners directly; there are no legacy root facades.

## Lifecycle ownership

The visible run sequence is resolve/validate → prepare → stage → execute → establish cleanup evidence → finalize owned resources → return outcome. Container removal is established before stage deletion or clone-reservation release because a live container may still write or mount those resources.

| Outcome                                     | Workspace                                   | Auth/resource stages                                 |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Success/nonzero/abort/timeout after removal | Bind untouched; clone retained and released | Discard source-only auth stage, then cleanup         |
| Setup failure before launch                 | Bind untouched; acquired clone discarded    | Release acquired resources                           |
| Removal or stage-cleanup failure            | Clone/reservation retained                  | Retain private stage and report recovery requirement |

Layout/dependency rules are reviewed manually with this map at migration changes; this project intentionally has no architecture-policing toolchain.
