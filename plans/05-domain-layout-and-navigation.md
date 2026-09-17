# Domain layout and repository navigation

**Status: planned. Documentation only; do not interrupt or overlap an active implementation.**

## Outcome

Finish organizing the repository into recognizable domains. A reader should be able to guess where a behavior lives without knowing the implementation history, and should find its types, tests, and documentation nearby.

This is a concrete directory and responsibility migration, not another round of optional helper extraction. Keeping code under `src/` is correct; keeping most domain entry points and tests directly in `src/` is the problem.

[Plan 04](04-readability-agent-configuration-and-documentation.md) defines agent integration and configuration behavior. This plan defines where that implementation belongs and how readers navigate it. Apply it after the current implementation reaches a stable review checkpoint. Adopt any completed moves rather than redoing them. Do not change configuration semantics, add agents, or redesign authentication as part of these moves.

## 1. What must change

The reviewed tree mixes two incompatible conventions:

- `auth.ts` and `auth/` both own authentication.
- `workspace.ts` and `workspace/` both own workspace operations.
- `run.ts` and `run/` both own execution.
- `podman.ts` owns argument construction, mounts, environment policy, and preflight while `container/` owns lifecycle.
- Root-level tests are separated from related tests already inside domain directories.
- `types.ts`, `defaults.ts`, and `options.ts` collect concepts belonging to several domains.
- `utils/fs.ts` mixes generic filesystem primitives with pi-pod state ownership and deletion policy.

Moving a few helpers while keeping these parallel structures does not complete the refactor. Nor does replacing the old files with permanent re-export facades.

### Definition of done for the root

At completion, the only runtime file directly under `src/` is:

```text
src/cli.ts                  trusted launcher's bootstrap target
```

All other runtime code and tests belong to the domains below. The package-root `index.ts` remains the public library entry point. Do not add a second `src/index.ts` or a root-level barrel for every domain.

This is a deliberate navigation rule, not a claim that a file is bad because it is long.

## 2. Target source layout

The following names are the migration destinations, not merely suggestions. Tests are shown separately in section 5 so the runtime map stays readable.

```text
index.ts                    stable public library exports
bin/pi-pod                  secure executable launcher
src/
  cli.ts                    existing bootstrap entry; keep its path stable
  cli/
    app.ts                  Crust composition and routing
    bootstrap.ts            caller environment restoration
    help.ts                 usage text
    signals.ts              CLI interrupt handling
    delegation.ts           user-systemd scope handling
    commands/               existing command actions

  agents/
    contract.ts             pure agent contract, IDs/modes, capability types
    registry.ts             explicit built-in definitions and lookup
    pi/
      definition.ts         native commands/environment/state paths
      credentials.ts        native credential codec
      dev-resources.ts      Pi-specific filtered development resources
    opencode/
      definition.ts
      credentials.ts

  config/
    types.ts                configuration envelope and resolved preference types
    schema.ts               strict declarative schema validation
    load.ts                 bounded explicit/dev-auto file loading
    resolve.ts              selected agent/mode and preference precedence

  execution/
    run.ts                  runAgent orchestration
    login.ts                login orchestration
    policy.ts               validated run defaults and policy resolution
    credentials.ts          acquire/stage the resolved credential source
    prompt.ts               bounded prompt staging
    finalize.ts             explicit run finalization and final outcomes
    types.ts                RunAgentOptions, LoginOptions, run/login results

  auth/
    credentials.ts          document validation and agent-codec dispatch
    host.ts                 approved host credential reading
    profiles.ts             persistent selected-provider metadata/storage
    lock.ts                 exclusive profile ownership
    staging.ts              native state staging and guarded recovery
    recovery.ts             public recover/discard/unlock operations
    types.ts                auth source/outcome and shared auth lifecycle types

  container/
    args.ts                 hardened Podman argument construction
    mounts.ts               mount syntax validation and construction
    environment.ts          forwarding policy and sanitized client environment
    preflight.ts            rootless/platform/cgroup validation
    lifecycle.ts            attached client and exact-container cleanup
    image.ts                default image reference and build recipe locations
    types.ts                launch, stream, and execution outcome contracts

  workspace/
    prepare.ts              bind/clone selection and workspace/state separation
    git.ts                  controlled Git inspection and cloning
    runs.ts                 retained-run metadata and reservations
    remove.ts               public guarded removeAgentRun operation
    types.ts                bind/clone discriminated types and workspace modes

  resources/
    limits.ts               resource defaults, types, and pure limit validation
    storage.ts              directory measurement and bounded storage monitoring

  state/
    paths.ts                configured/canonical private state-root policy
    removal.ts              quarantine/revalidate deletion primitive
    identifiers.ts          validated state path-component identifiers

  utils/
    fs.ts                   bounded descriptor reads, private writes, directory primitives
    paths.ts                domain-neutral path containment/canonicalization
    process.ts              sanitized host helper execution

  test-support/
    fake-podman.ts          minimal reusable process fixtures
    temporary-state.ts     isolated temporary directories/environment restoration
```

`config/` entries describe responsibilities for Plan 04's implementation. If its final filenames differ, consolidate them into these roles during this migration; do not create empty modules for functionality that has not shipped. Agent-specific preference translation remains with that agent rather than becoming branches in shared lifecycle code.

`resources/` means execution budgets and storage enforcement. Agent extensions/plugins/skills live with their adapters and configuration, not in this directory. State paths are wrapper-owned control storage; they are not resource catalogs.

Do not create a `common/`, `services/`, `managers/`, or `core/` dumping ground to avoid choosing an owner.

## 3. File-by-file migration map

| Current location | Destination and disposition |
| --- | --- |
| `src/run.ts` | `execution/run.ts`; move `removeAgentRun` to `workspace/remove.ts`; extract its finalization block to `execution/finalize.ts`. Remove the old file. |
| `src/login.ts` | `execution/login.ts`. Keep shared container lifecycle; do not combine login and run into one universal workflow. |
| `src/run/options.ts` | `execution/policy.ts`; CLI and library share this resolver. |
| `src/run/credentials.ts` | `execution/credentials.ts`; shared auth types go to `auth/types.ts`. Remove the emptied `run/` directory. |
| `src/prompt.ts` | `execution/prompt.ts`, retaining its byte bound and private staging behavior. |
| `src/auth.ts` | Actual public recovery operations go to `auth/recovery.ts`; imports/re-exports are replaced with direct imports. Remove the facade. |
| `src/podman.ts` | Split its existing responsibilities into `container/args.ts`, `mounts.ts`, `environment.ts`, and `preflight.ts`. Remove the old file. |
| `src/workspace.ts` | `workspace/prepare.ts`; use direct imports for reservation/removal helpers rather than re-exporting them from preparation. |
| `src/workspace-usage.ts` | `resources/storage.ts`; rename workspace-specific monitor terminology to storage terminology because auth staging also uses it. Preserve messages and behavior unless a separately reviewed change requires otherwise. |
| `src/options.ts` | Resource validation to `resources/limits.ts`; timeout validation to `execution/policy.ts`. Remove the old file. |
| `src/defaults.ts` | Image default to `container/image.ts`; headless timeout to `execution/policy.ts`; resource defaults to `resources/limits.ts`. Remove the catch-all file. |
| `src/types.ts` | Move types to their owning domains, as below; retain their package exports through `index.ts`. Remove the catch-all file. |
| `src/utils.ts` | `validIdentifier` to `state/identifiers.ts`; `isInside` to `utils/paths.ts`; Podman mount-path validation to `container/mounts.ts`. Remove the old file. |
| `src/utils/fs.ts` | Keep generic I/O; move state-root functions to `state/paths.ts`, canonical path resolution to `utils/paths.ts`, and guarded quarantine removal to `state/removal.ts`. |
| `src/agents.ts`, `src/dev-resources.ts` if still present | Complete their Plan 04 moves to `agents/`; do not preserve duplicate entry points. |

### Type ownership

- Agent identity, execution-mode vocabulary, and definition capabilities: `agents/contract.ts`. Registry completeness must be checked against the declared IDs; adding an ID without an implementation is a type/test failure.
- `RunAgentOptions`, `LoginOptions`, `RunResult`, `LoginResult`: `execution/types.ts`.
- Auth source selection and `AuthOutcome`: `auth/types.ts`.
- `PreparedWorkspace`, bind/clone variants, `WorkspaceMode`: `workspace/types.ts`.
- `ResourceLimits`: `resources/limits.ts`, alongside its defaults and validation.
- `OutputSinks`, stream-delivery outcome, container launch/cleanup/result contracts: `container/types.ts`.
- Configuration envelope: `config/types.ts`; agent-native preference types remain with the owning agent.

Keep narrow private types beside their sole implementation. A domain `types.ts` is for genuinely shared contracts, not every local record. Type-only imports must not trigger runtime registry/config loading.

The existing `package.json` exports only the package root. Preserve every documented root export and signature by updating `index.ts` directly. Internal source paths are not a reason to leave permanent compatibility files. If an actual supported deep import is discovered, document a migration decision instead of silently breaking it or keeping every old path forever.

## 4. Module boundaries, not just folders

### Allowed direction

- `utils/` knows no domain policy and imports no domain modules.
- `state/` uses generic filesystem/path primitives, not execution or agent code.
- `resources/` defines limits/measurement without knowing credentials or agents.
- Pure agent definitions/codecs know their contract and primitive helpers. Agent-specific resource preparation may use `state/` and I/O, but never launches a host agent or controls Podman.
- `config/` validates/selects agent preferences; it never acquires credentials, prepares a workspace, or launches a container. Agent definitions do not import the config loader/resolver.
- `container/` may consume agent command definitions and resource contracts; it does not import execution workflows, auth storage, or workspace operations.
- `auth/` and `workspace/` may consult the existing exact-container existence probe for safe recovery/removal. They do not import `execution/` or each other. Workspace/state overlap checks use `state/` directly.
- `execution/` composes these domains. It contains the top-level run sequence and ordering decisions.
- `cli/` adapts input/output and calls explicit operations; domain code never imports CLI code.
- Internal modules never import the package-root `index.ts`.

Keep the existing public `buildPodmanRunArgs` entry compatible. Its lower-level implementation must retain a visible hardening argument list; do not bury each flag in its own helper or make agent adapters supply arbitrary mount/Podman options.

No broad domain barrels. Import `auth/recovery.ts` for recovery, not `auth/index.ts` to discover what it transitively exports. A reader should identify the owning behavior from the import path.

### Execution finalization

`execution/run.ts` must show this sequence without hiding it behind a framework:

```text
resolve/validate → prepare → stage → execute → establish cleanup evidence
→ finalize owned resources → construct/return outcome
```

`execution/finalize.ts` is not a generic disposer. It takes explicit acquired resources plus launch/removal evidence and returns final auth/workspace cleanup outcomes. Preserve cleanup on exceptions as well as ordinary exits; do not move finalization out of `finally` without equivalent control-flow coverage.

The container-removal barrier, lock-release conditions, retained-stage cases, and distinction between unlaunched and launched clones must be visible. Avoid returning a result whose meaning is subsequently changed through hidden mutations.

If moving this logic exposes a correctness issue, record and fix it with a focused regression in a separate behavior change. A directory migration must not silently change recovery or deletion policy.

## 5. Tests must follow the domain

No `src/*.test.ts` files remain when this plan is complete.

| Current test group | Destination |
| --- | --- |
| `auth.test.ts` | `auth/profiles.test.ts`, `auth/staging.test.ts`, `auth/host.test.ts`, and `auth/recovery.test.ts`, partitioned by behavior; lock-specific cases beside `lock.ts`. |
| `run.test.ts` | `execution/run.test.ts` for general outcomes; focused `execution/auth-lifecycle.test.ts`, `execution/cancellation.test.ts`, `execution/login.test.ts`, and `execution/retention.test.ts`. |
| `prompt.test.ts` | `execution/prompt.test.ts`. |
| `options.test.ts`, `run/options.test.ts` | `resources/limits.test.ts` and `execution/policy.test.ts`. |
| `podman.test.ts` | `container/args.test.ts`, `environment.test.ts`, and `mounts.test.ts` by assertion responsibility. |
| `preflight.test.ts` | `container/preflight.test.ts`. |
| `podman.integration.test.ts` | `container/podman.integration.test.ts`. |
| `workspace.test.ts` | `workspace/prepare.test.ts`, `git.test.ts`, and `remove.test.ts`; reservation-specific tests may stay beside `runs.ts`. |
| `workspace-usage.test.ts` | `resources/storage.test.ts`. |
| `utils.test.ts` | `utils/fs.test.ts` and `state/removal.test.ts`. |
| `cli.test.ts` | `cli/bootstrap.test.ts` for hostile launch/runtime fixtures and `cli/app.test.ts` for parsing/dispatch. |
| Already colocated tests | Keep them beside the owning module; update imports and fixture paths. |

Test helpers may create temporary state, supply fake Podman responses, and restore environment changes. They must not hide assertions such as “no host state was read,” “container absence was verified,” or “credential reconciliation occurred after removal.” Do not turn scenario fixtures into a mini mocking framework.

Update `import.meta.dir`-relative fixture paths after moves. Keep tests independent of personal HOME/XDG state and preserve reliable cleanup even when assertions fail. Do not merge superficially similar scenarios and lose adversarial coverage.

## 6. Make the layout discoverable and enforceable

### Maintained navigation

Update `docs/architecture.md` with the final directory map, dependency rules, and this task-oriented index:

| Question | Start here |
| --- | --- |
| How does a run work? | `execution/run.ts`, then `execution/finalize.ts`. |
| Where do defaults and source selection come from? | `execution/policy.ts`, `config/resolve.ts`. |
| How do I add an agent? | `agents/contract.ts`, `agents/registry.ts`, then an existing adapter. |
| Which native configuration is permitted? | `config/schema.ts`, then the selected agent's translation. |
| What crosses the container boundary? | `container/args.ts`, `mounts.ts`, `environment.ts`. |
| What happens after cancellation? | `container/lifecycle.ts`, then `execution/finalize.ts`. |
| Who owns credentials and recovery? | `auth/staging.ts`, `lock.ts`, `recovery.ts`. |
| Can this directory be deleted? | `workspace/remove.ts`, `runs.ts`, `state/removal.ts`. |
| Where are budgets enforced? | `resources/limits.ts`, `storage.ts`. |
| How does the host stay safe before container startup? | `bin/pi-pod`, `cli/bootstrap.ts`, `workspace/git.ts`. |

Keep module-header comments short: responsibility, trust assumptions, and important callers. Do not add an identical README in every folder or force readers through a sequence of re-export files. Public API docs link to operations; contributor docs link to implementation owners.

Update `AGENTS.md`, README links, `docs/development.md`, test commands, and any scripts that refer to moved files. Historical reviews keep their original locations as evidence; link them to the maintained architecture map rather than rewriting historical findings. A repository-wide search must classify remaining old paths as intentional history or fix them.

### Mechanical checks

Add a small Bun/TypeScript structure check under `scripts/check-structure.ts` and expose it as `bun run check:structure`.

It should verify:

1. Only `cli.ts` is a runtime source file directly under `src/`; root tests and legacy facade files are absent.
2. Runtime code never imports test helpers, tests, or the package public barrel.
3. The domain dependency rules above hold, including forbidden upward imports.
4. There are no runtime module cycles. Report type-only cycles separately; do not use them to conceal unclear ownership.
5. The check discovers new source files rather than relying on a frozen list of existing files.

Use the existing TypeScript tooling to inspect imports/re-exports where needed; do not add a dependency-injection framework or a new architecture toolchain. Keep the rule table readable. If legitimate dependencies fail a rule, review the boundary rather than accumulating unexplained exceptions.

Exclude `src/test-support/**` and tests from packed runtime files. Verify packed artifacts actually contain the relocated code and maintained docs. The external launcher/bootstrap path and package-root export contract must continue to work from a hostile workspace.

### Uniform formatting

Adopt **Prettier** as the single repository formatter. It covers TypeScript, JSON, and Markdown, so code, examples, and maintained documentation follow one tool rather than separate formatting conventions. Do not add a parallel formatter or a lint framework as part of this task.

- Add a reviewed stable Prettier release as an **exact-pinned development dependency**, using Bun, and update `bun.lock`. Do not use a floating version or download an unpinned formatter during checks.
- Add a declarative `.prettierrc.json`: two-space indentation, semicolons, double quotes, trailing commas, 100-column print width, LF line endings, and `proseWrap: "preserve"`. Prefer Prettier defaults where they already match; avoid plugins and per-directory stylistic exceptions.
- Add `.prettierignore` for dependencies, generated/build output, caches, lockfiles, and generated fixtures. Keep all ordinary source, tests, scripts, JSON examples, and Markdown documentation in scope. Formatting must stay within this checkout and never traverse personal state or sibling repositories.
- Add `format` (`prettier --write .`) and `format:check` (`prettier --check .`) scripts. Run them through the repository-pinned Bun environment. Check mode must never rewrite files.
- Format the initial tree in a distinct formatting-only checkpoint before moving modules. Review that diff separately from semantic or structural edits; record the checkpoint without making a Git commit unless the user requests one.
- Inspect embedded shell scripts, adversarial fixtures, and whitespace-sensitive examples after formatting. Preserve test payloads and expected behavior; targeted formatter-ignore comments need an explanation, not a blanket exclusion of security tests.
- Document commands and editor integration in `docs/development.md` and `AGENTS.md`. Do not modify the user's editor settings, install hooks, or add automatic staged-file rewriting.
- Keep Prettier and formatter setup out of the runtime image and production package surface. Include `format:check` in the repository's aggregate validation command and existing CI, if present.

Uniform formatting is mandatory at completion. This is not a broad rename/import-sort/lint cleanup disguised as formatting; those changes require their own rationale.

## 7. Migration sequence

Do not ask a concurrent worker to start these moves while it is editing the same tree. Begin from a reviewed checkpoint and preserve unrelated work. The phases below are reviewable implementation steps, not permission to stop halfway and describe the layout as complete.

### Phase 0 — Establish uniform formatting

- Record a passing test/typecheck baseline before adding the pinned formatter.
- Add formatter configuration, ignore rules, scripts, and contributor instructions.
- Apply a repository-wide formatting-only pass and review it independently of module moves.
- Verify tests/typecheck still pass, and that a second formatting pass makes no changes.

**Gate:** `format:check` passes across the maintained tree with no runtime behavior changes, unpinned tooling, or broad source/test exclusions.

### Phase 1 — Record contracts and move coherent domains

- Record public exports, tests, runtime defaults, and supported entry points.
- Move workspace preparation/removal, auth recovery, prompt staging, and corresponding tests to their final owners.
- Replace all consumers with direct imports; remove old facades immediately within each completed move.
- Preserve on-disk formats and behavior.

**Gate:** no parallel old/new ownership for moved domains; tests and public import smoke tests pass.

### Phase 2 — Separate lower-level responsibilities

- Split Podman arguments, mounts, environment, and preflight into `container/`.
- Move storage enforcement and resource limits to `resources/`.
- Separate state-root/deletion policy from generic filesystem primitives.
- Move domain defaults and types; eliminate root `types.ts`, `options.ts`, `defaults.ts`, and `utils.ts`.

**Gate:** lower domains have no upward imports, hardening remains easy to audit, and all existing security regressions survive.

### Phase 3 — Complete execution organization

- Move run/login and remaining `run/` helpers into `execution/`.
- Extract explicit finalization while preserving every failure path and public outcome.
- Split large orchestration tests by behavior and introduce minimal shared fixtures.
- Remove the old root files and empty directories.

**Gate:** `src/cli.ts` is the only root runtime file, all tests are colocated, and finalization order is clear without chasing generic hooks.

### Phase 4 — Navigation, packaging, and enforcement

- Finish maintained source maps, task-oriented documentation, and test-command updates.
- Add structure/dependency checks and run them as part of contributor validation.
- Test package installation/import/launcher from a disposable consumer with hostile Bun configuration.
- Check the final tree and imports against the acceptance checklist; no compatibility scaffolding remains without a documented public requirement.

**Gate:** both filesystem navigation and dependency direction match the target, rather than only the names of a few folders.

## 8. Validation and acceptance

For each phase:

```sh
mise exec -- bun run format:check
mise exec -- bun test
mise exec -- bun run typecheck
git diff --check
```

Use `mise exec -- bun run format` to apply formatting intentionally; run check mode at every subsequent gate. During Phase 0, establish the pre-format test/typecheck baseline before the formatting scripts exist.

After introducing the structure check:

```sh
mise exec -- bun run check:structure
```

Run opt-in integrations only on a suitable host, using the relocated paths after migration:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Inside a development container without Mise, verify its Bun version matches the repository pin before substituting direct Bun commands. Never use real credentials or paid model requests for the migration suite.

Completion requires all of the following:

- [ ] `src/cli.ts` is the only root runtime file; there are no root tests.
- [ ] No sibling `auth.ts`/`auth/`, `workspace.ts`/`workspace/`, or `run.ts`/`run/` convention remains.
- [ ] Every runtime module, shared type, default, and test has a domain owner.
- [ ] No catch-all root types/options/defaults/utilities or replacement dumping ground exists.
- [ ] No permanent re-export shims preserve obsolete internal paths.
- [ ] The package-root public API and trusted launcher retain compatibility.
- [ ] State ownership and deletion policy are not hidden inside generic filesystem utilities.
- [ ] Storage enforcement is named for all its callers, not just workspaces.
- [ ] Execution and finalization ordering is legible and behaviorally covered.
- [ ] Maintained documentation and test commands point to real final paths.
- [ ] Structure checks enforce the root layout and dependency rules.
- [ ] One exact-pinned formatter covers source, tests, examples, and documentation; `format:check` passes and formatting is idempotent.
- [ ] The initial formatting pass was reviewed separately from structural/behavior changes, and formatter tooling is development-only.
- [ ] Unit, adversarial, typecheck, packaging, and applicable integration results are recorded honestly.

Do not equate “tests pass” or “files are smaller” with completion. The final review must use the task-oriented navigation table to find each behavior, inspect the final source tree, and verify that the old parallel organization has actually been removed.

## Non-goals

No new agents, configuration semantics, privilege changes, generic plugin/runtime registration, daemon, analytics capture, credential broker, automatic commits, registry publication, or host shell/tmux modifications. Preserve rootless containment, explicit autonomous inputs, guarded retained-run deletion, and source-only host auth. Keep the package private and its existing Apache-2.0 with Commons Clause licensing unchanged.
