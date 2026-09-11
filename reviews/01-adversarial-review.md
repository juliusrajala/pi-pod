# Adversarial review: initial implementation

Status: implementation restarted in small review gates. **Do not yet rely on this wrapper for hostile repositories or real credentials.** Findings remain historical evidence; implementation checkpoints below record their narrow fixes and verification.

## Review sequence

1. [x] Read implementation, instructions, and plan; run baseline tests.
2. [x] Probe host-side Git execution and clone retention.
3. [x] Review container lifecycle, cancellation, and credential recovery together.
4. [x] Verify native credential writers and agent-specific authentication assumptions (real account login/refresh remains untested).
5. [x] Review public API, CLI validation, packaging, and installation experience.
6. [x] Recommend small, readable module boundaries and missing tests.
7. [x] Consolidate severity-ranked findings and remediation order.

Each pass records evidence here before moving on. Temporary probes use disposable fixtures under `/tmp/pi-pod-review/`, not personal credentials or production workspaces.

## Baseline

- `bun test`: 9 pass, 1 opt-in integration test skipped.
- `bun run typecheck`: pass.
- `git diff --check`: pass.
- Local Podman reports rootless execution and cgroup v2; the built image is present.
- Current tests do not exercise the actual run lifecycle or CLI parser.

## Implementation checkpoint 1 — host execution boundary

Completed: R1 and R9's first remediation gate.

- Added an executable `bin/pi-pod` launcher. It starts Bun with its cwd at the trusted installed package root and `--no-env-file`, then `src/cli.ts` restores the original cwd and HOME before application work begins. This prevents a target workspace `bunfig.toml` preload or `.env` from executing/configuring the CLI before containment.
- Changed the public package binary and source-checkout documentation to use that launcher. Directly invoking `src/cli.ts` remains deliberately documented as unsafe from an untrusted workspace.
- Reworked clone inspection to use a minimal Git environment, discard inherited `GIT_CONFIG_*` injection, inspect all non-symlinked working-tree `.gitattributes` plus `.git/info/attributes`, and reject filter assignments before `git status` can refresh a dirty file.

Regression evidence:

- New `src/cli.test.ts` creates a hostile cwd Bun preload and verifies the launcher prints help without creating its marker.
- New `src/workspace.test.ts` configures a real clean filter whose command would create a host marker; clone preparation rejects the filter and the marker remains absent.
- A separate `bun pm pack` → disposable consumer → installed `pi-pod --help` smoke test passed with the same hostile preload fixture.
- `bun test` (11 pass, 1 opt-in skip), `bun run typecheck`, and `git diff --check` pass after this checkpoint.

Known boundary: this protects the documented launcher. A trusted library caller controls its own Bun bootstrap, and no TypeScript source launcher can prevent preloads if a caller intentionally starts Bun in an untrusted cwd before pi-pod code begins.

## Implementation checkpoint 2 — retained clone collision

Completed: R2's destructive collision path.

`prepareClone` now atomically creates `runs/<run-id>` without recursive replacement. An existing ID fails with an instruction to inspect or explicitly remove the retained run. The cleanup handler runs only after this process has acquired that new directory, so it cannot clean a predecessor's work.

Regression evidence: `src/workspace.test.ts` prepares a retained clone, writes an uncommitted sentinel, retries the same ID, verifies the retry fails, and verifies the sentinel remains. The focused test and typecheck pass.

This does not yet establish that a directory is wrapper-owned or solve the symlinked-state and active-container removal issues in R5; those require a dedicated state-ownership design rather than another local deletion guard.

## Implementation checkpoint 3 — state/workspace separation and removal evidence

Completed: the first portion of R5.

- Every prepared workspace is rejected when it lexically contains—or is contained by—the configured pi-pod state path. This prevents the straightforward project-local `XDG_STATE_HOME` case from mounting credentials/control metadata into `/workspace`.
- Runs storage is now a private, non-symlink directory before removal. `removeRun` requires a real run directory and matching wrapper-written `run.json` metadata before deletion. The public package no longer exports this low-level removal helper; callers use `removeAgentRun`, which also checks Podman labels.
- Private wrapper directories are now checked for current-user ownership and normalized to mode `0700` when acquired.

Regression evidence: focused workspace tests cover state/workspace overlap, an unowned directory without metadata, a symlinked runs directory, and retained-work collision. All preserve their sentinels.

Deliberately not claimed complete: canonical overlap through unusual parent symlinks, serialized removal/preparation, and container-aware removal remain open R5 work. The next lifecycle checkpoint must make removal and credential recovery wait for verified container termination.

## Implementation checkpoint 4 — verified container lifecycle and credential staging ownership

Completed: the core R3/R4 path.

- Added `src/container/lifecycle.ts`, the single owner for an attached `podman run` invocation. It registers abort handling before run monitoring starts; interrupts the Podman client; polls for a delayed container; applies graceful stop, kill, and force-remove as needed; and reports whether absence was verified. `runAgent` and `login` both use it.
- `RunResult` now carries explicit cleanup status. The CLI reports an unverified cleanup as failure instead of treating client exit as containment success.
- Auth locks and stages record the managed container name (or explicit `null` for a non-container operation). Unlock, recovery, and discard refuse to proceed while the associated container exists. When a launched run cannot verify removal, it retains both stage and lock rather than reconciling possibly live credentials.

Regression evidence:

- `src/container/lifecycle.test.ts` uses a fake Podman whose run process ignores the first termination signal, creates its container late, and exits only after a later stop. The lifecycle waits, finds it, removes it, and reports verified cleanup.
- Auth tests prove both stale-lock unlock and staged-credential recovery reject a still-existing named container.
- A credential-free real-Podman Pi smoke run reached Pi's expected no-auth error, retained its clone, and left no managed container.

Open work within these findings: preflight cancellation/platform validation, stronger container-label verification, cleanup/result semantics for every setup failure, profile-creation serialization, and canonical state-path ownership. These remain open rather than being implied solved by this checkpoint.

## Implementation checkpoint 5 — OpenCode bundled authentication

Completed: R6's configuration error.

Removed `OPENCODE_DISABLE_DEFAULT_PLUGINS=true`. OpenCode still uses `--pure`, which disables external/project plugin origins, but its bundled authentication integrations—including the pinned Codex subscription plugin—remain available to login and task runs. The OpenCode argv test now asserts that the disabling environment variable is absent, and the README no longer claims default plugins are disabled.

This confirms wrapper configuration only. It does **not** validate a real account login, credential reuse, refresh, or the exact provider/method UX; those remain deliberate user-assisted tests after the credential-schema and UID work.

## Implementation checkpoint 6 — credential schemas and UID-independent native writes

Completed: R7 and R8's primary paths.

- Extracted provider credential parsing/normalization into `src/auth/credentials.ts`, leaving `auth.ts` focused on profiles, locks, staging, and recovery. Pi profiles intentionally support only the confirmed `openai-codex` OAuth form. OpenCode supports the pinned native `oauth`, `api`, and `wellknown` shapes. The normalizer constructs a new selected credential object from allowed fields; it does not copy unknown fields or unrelated providers.
- Replaced a mounted auth file with a narrowly staged, writable auth-state directory. The agent can create its native lock/sibling files there, while stage metadata stays in the parent directory outside the mount. Reconciliation reads only `agent-state/auth.json` and persists only the selected decoded credential.
- This removes the image UID-1000 dependency without a privileged/root entrypoint: the staged directory is host-owned and maps to the caller's keep-id UID at its mount point.

Regression evidence:

- Auth tests cover Pi Codex persistence, native OpenCode `type: "api"` persistence, unrelated-provider exclusion, and unsupported-field rejection.
- The opt-in Podman test now remaps the host user to container UID/GID 1234 and exercises Pi's pinned native `AuthStorage.modify`; it successfully creates its lock and updates the staged credential.

Follow-up: concurrent profile creation now atomically claims `profile.json`; conflicting simultaneous provider creation produces one success and one explicit ownership error, covered by a regression. Auth staging has a separate size limit. Remaining scope is user-assisted real OAuth login/reuse/refresh for Pi and OpenCode, provider/method UX discovery, and an explicit version-upgrade test policy. The model/auth schema is intentionally not claimed universal for every provider.

## Implementation checkpoint 7 — pinned CLI runtime, Crust routing, and auth boundaries

Completed: the R10 parser/action boundary and the deferred readability split.

- Added `.mise.toml` and a package Bun engine floor of `1.3.14`; the secure launcher rejects older Bun versions before loading CLI code. Updated the image to Bun `1.3.14` with the release ZIP SHA-256 `951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f`.
- Added the exact `@crustjs/core@0.0.19` dependency. The published package API differs from the reviewed upstream checkout, so the application uses its supported `new Crust(...).command(...)` composition API rather than unreleased helpers.
- Replaced the handwritten argv loop with `src/cli/app.ts` and small `src/cli/commands/*.ts` definitions. Crust resolves commands, validates declared flags/types/choices/required values, and preserves tokens after `--` as `rawArgs`. `src/cli.ts` is now only the secure bootstrap; the existing shell launcher remains the trusted Bun entry point.
- Core `0.0.19` collects surplus positionals and raw arguments rather than rejecting them. Each command declares a variadic collector and calls two shared, side-effect-free preconditions before workspace, auth, or Podman work. This preserves strict wrapper command boundaries without reinstating a bespoke argv parser; only `dev` and `run` permit `rawArgs`.
- Split the former mixed `src/auth.ts` into `profiles.ts` (persistent selected-provider storage), `lock.ts` (exclusive ownership), and `staging.ts` (mounted state/recovery). `auth.ts` is a small compatibility facade and `credentials.ts` remains the pure decoder/normalizer. On-disk profile, lock, and stage formats are unchanged.

Regression evidence:

- CLI tests run a hostile caller cwd and a fake Podman executable. The launcher rejects an old Bun shim; unknown flags, surplus positionals, and forbidden `--` arguments exit before Podman, auth state, or workspace actions; a direct Core parse test verifies `dev ... -- --help --model gpt-5` reaches `rawArgs` unchanged rather than invoking wrapper help.
- Existing auth profile/stage/lock regressions pass unchanged after the split.
- `bun run typecheck` and `bun test` pass after this checkpoint (23 pass, 2 opt-in integration skips).

## Implementation checkpoint 8 — canonical state paths and retained-run reservations

Completed: the next R5 ownership/deletion gate.

- State resolution now canonicalizes existing parents, including a dangling XDG-state symlink, before workspace overlap is decided. Rejected bind workspaces do not create the state leaf. Once state is needed, auth, staging, and runs all use the same canonical, current-user-owned private root.
- Clone metadata can carry an internal reservation containing the wrapper PID and exact generated container name. `runAgent` reserves an owned clone before startup, removes an unlaunched reservation only after confirming that container name is absent, and releases the reservation only after lifecycle cleanup verified container removal.
- `removeRun` now fails closed while the reserving process exists. If that process is gone, it queries the exact recorded container before deletion; `removeAgentRun` retains its label query as an additional active-container check. Standalone `prepareWorkspace` callers do not receive a launch reservation and may remove their retained clone normally.

Regression evidence:

- A bind fixture whose dangling `XDG_STATE_HOME` symlink canonically resolves inside the workspace is rejected without creating state under that workspace.
- A live reservation preserves uncommitted sentinel work until it is explicitly released after cleanup.
- A dead-PID reservation with a fake still-existing exact container refuses deletion and preserves its sentinel.
- `bun run typecheck` and `bun test` pass after this checkpoint (26 pass, 2 opt-in integration skips).

Follow-up: all wrapper-controlled state descendants now canonicalize and validate beneath the private state root; a regression rejects a symlinked auth subtree before it can create a user-owned leaf outside state. Bounded reads open the final file descriptor with `O_NOFOLLOW`, and retained-run deletion now atomically quarantines then revalidates metadata/reservation before recursive removal; failed revalidation restores the run. `RunResult.cleanup.reservation` now reports `not-owned`, `released`, or `unreleased`; an unreleased reservation also makes the CLI fail. A fake-Podman clone regression verifies a retained clone is removable only after its result reports `released`. Still open in R5 is fully descriptor-anchored recursive deletion against an attacker that can replace a directory with another matching metadata tree. That limit is not claimed solved by this checkpoint.

## Implementation checkpoint 9 — preflight limits and private task staging

Completed: R12’s primary validation path and R13.

- Added pure `src/options.ts` validation before workspace, auth, or Podman work. Memory must be nonzero, CPU must be positive, PIDs and byte budgets must be positive safe integers, and library timeouts must be positive integer milliseconds. Fractional CPU remains intentionally supported by Podman.
- Preflight now requires native Linux, rootless non-remote Podman, and cgroup v2. The workspace usage budget is measured before container start; ordinary entries that disappear after directory enumeration are ignored rather than making the remaining workspace unmeasurable.
- Headless task text is now bounded to 256 KiB and staged under private wrapper state. Podman receives a read-only mount at `/run/pi-pod-prompt`, and a fixed shell program reads that file only inside the container before invoking Pi/OpenCode. Neither file contents nor prompt-file contents appear in the host Podman argv. Staging is retained if container removal is unverified. Native writable auth staging has a separate 1 MiB preflight/runtime budget, including native lock/cache siblings.

Regression evidence:

- Pure option tests reject zero memory, fractional integer limits, overflow, and invalid library timeouts. Fake-Podman preflight tests reject cgroup v1 and remote services. A workspace already over its budget fails before launch, and an auth fixture proves native staging has its own bounded budget.
- Prompt staging tests cover byte bounds and cleanup. The opt-in real-Podman test mounts a task file, verifies its contents in the container, and proves it is not writable; both existing native-auth and updated mount tests pass.
- `bun run typecheck` and `bun test` pass after this checkpoint (31 pass, 2 opt-in integration skips); `PI_POD_INTEGRATION=1 bun test src/podman.integration.test.ts` passes (2 pass).

Deliberately still open in R12: descriptor-level monitor races and a quota-backed hard aggregate-disk guarantee. These do not affect the corrected option validation, staged-auth budget, or task-file argv boundary.

## Implementation checkpoint 10 — bounded output and structured auth outcomes

Completed: R11’s primary library contract path.

- `RunAgentOptions` and `LoginOptions` now accept optional Web `WritableStream` stdout/stderr sinks. The shared lifecycle uses backpressured `pipeTo` forwarding and otherwise preserves inherited terminal streams; pi-pod does not accumulate agent output in memory.
- `RunResult` now includes an explicit `auth` outcome: reconciliation is `not-used`, `persisted`, or `retained`, and the profile lock is `not-used`, `released`, `retained`, or `release-failed`. Final reconciliation updates this result rather than being only a diagnostic after a nominally successful agent exit. The CLI treats a clean agent exit with retained credential state as failure and gives recovery guidance.

Regression evidence:

- Lifecycle tests stream separate fake Podman stdout/stderr into caller sinks and prove a failed sink terminates the client, removes its container, and returns a structured output error.
- End-to-end fake-Podman run tests prove a no-auth result, bounded stream forwarding, and an agent exit zero whose credential reconciliation fails returns `auth: { reconciliation: "retained", lock: "released", ... }` rather than hiding it.
- `bun run typecheck` and `bun test` pass after this checkpoint (34 pass, 2 opt-in integration skips).

Remaining R11 work: a structured result for setup failures (which still throw) and a bind-run identifier if automation needs one. These are not claimed complete by this checkpoint.

## Implementation checkpoint 11 — explicit package surface and minimal tarball

Completed: the primary packaging hygiene recommendations.

- `package.json` now declares explicit Bun import/types exports and a runtime-only `files` allowlist. Packed artifacts contain the public entry point, launcher, container recipe, README, and runtime source, but omit tests, plans, reviews, development instructions, and TypeScript configuration. Image builds now use `container/` as their entire context rather than sending source, Git metadata, or `node_modules` to Podman.
- A fresh packed-tarball consumer smoke test installed the package, imported `runAgent` through its declared export, and ran the installed binary from a hostile `bunfig.toml` cwd without executing the preload. The image build path remains present in the artifact; a rebuilt image reports Bun `1.3.14`.

Decision: v0.1 is local-only/self-hosted, so the package intentionally remains `private`; source-checkout, local-tarball, and local-link use are the supported distribution paths. `@crustjs/core@0.0.19`'s published TypeScript peer range still produces a consumer warning with the Bun-compatible TypeScript 5.9 toolchain. Runtime/typecheck behavior remains covered; this upstream peer mismatch is documented rather than hidden.

## Implementation checkpoint 12 — setup and client-exit lifecycle regressions

Completed: targeted R3/R4 setup safety coverage.

- New auth-profile metadata is claimed with exclusive creation, so simultaneous requests for the same agent/profile but different providers cannot silently overwrite each other.
- `runAgent` and `login` reject an already-aborted signal before staging a prompt, creating state/profile files, or invoking Podman.
- Lifecycle regression coverage now includes an attached `podman run` client that exits normally while its named container remains. The lifecycle detects and removes that leftover before reporting success.
- Regressions also retain the delayed-container abort and failed output-sink cleanup cases. These use fake Podman and no credentials.
- The CLI now detects this specific rootless/cgroup-v2 controller-delegation failure and transparently re-execs the trusted launcher in a transient `systemd-run --user --scope` with `Delegate=yes`. It preserves the caller cwd and terminal without a user wrapper command, and prevents recursion with an internal marker. The opt-in systemd integration test runs the normal launcher against fake Podman and separately proves a pseudo-terminal remains attached in that scope.

Still open: setup errors are exceptions rather than a separate structured result, and no test can prove real provider OAuth behavior without a user account interaction.

## Implementation checkpoint 13 — separate interactive host credentials from autonomous profiles

Completed: mode-specific Pi credential policy.

- Interactive Pi `dev` now defaults to the explicit `host` source. It reads the selected `openai-codex` value from host `~/.pi/agent/auth.json` through a bounded no-follow read, normalizes it into a private temporary agent-state directory, and never mounts or writes the host Pi directory.
- Headless `run` rejects `--auth host` before workspace, state, or Podman side effects. It retains the autonomous profile/API-key policy. OpenCode continues to use pi-pod-owned profiles unless explicitly configured otherwise.
- Host stages are marked separately from persistent-profile stages. They are discarded after verified cleanup; a later dev launch removes an interrupted host stage only after its recorded container is absent. They are never reconciled into a pi-pod profile or host credential file.
- The image now installs `fd` at its expected command name, preventing Pi from downloading a multi-megabyte helper into the bounded writable auth stage. The opt-in image test asserts it exists.
- Interactive dev now also loads trusted user extensions by default. Direct `~/.pi/agent/extensions` and local package roots declared in host Pi settings are read-only mounts; pi-pod writes a filtered private settings file containing only extension package declarations and default provider/model/thinking preferences. General settings, sessions, skills, themes, analytics, and remote npm/git package installation are excluded. `-- --no-extensions` disables these mounts and Pi extension loading explicitly.
- Regressions prove host staging strips unrelated credentials, agent changes are not written back to host auth, interactive defaulting mounts only the wrapper credential stage plus explicitly allowed read-only extension resources rather than host Pi state, and headless host-auth requests fail closed.

Known tradeoff: a provider may rotate a refresh token server-side while a source-only dev stage is active. pi-pod deliberately does not mutate the host file, so host Pi may require a later re-login. This is the explicit security/developer-experience boundary for v0.1.

## Pass 1 — Host Git and workspace ownership

### R1 — High: clone validation can execute repository-defined commands on the host

Locations: `src/workspace.ts`, `gitEnvironment`, `git`, and `assertCloneableRepository`.

`git status` runs before the filter-attribute check, using source-local Git configuration. Disabling hooks and fsmonitor does not disable clean filters. The helper also inherits all of `Bun.env`, including executable Git overrides and any project-loaded environment.

Confirmed with a disposable repository: commit a file and a `.gitattributes` clean-filter assignment, configure a harmless filter that writes a marker outside the repository, then modify the tracked file without changing its length. `prepareWorkspace(..., mode: "clone")` rejects the dirty repository, **but the host marker already exists**. No container was needed.

Required direction: make host-side source inspection non-executable before invoking status or any similar operation. Use a deliberately controlled Git environment and a design that does not consume arbitrary source executable configuration. Merely moving the current regex earlier is insufficient for all Git configuration paths. Add malicious Git configuration fixtures as regression tests.

### R2 — High: reusing a run ID destroys retained work

Location: `src/workspace.ts`, `prepareClone`.

Clone creation unconditionally recursively removes `runs/<run-id>` before creating it. `prepareWorkspace` is publicly exported and accepts a caller-supplied run ID.

Confirmed: prepare clone `reused`, write an uncommitted sentinel in that clone, then prepare another clone with ID `reused`. The sentinel is deleted without any removal request or container-termination check.

Required direction: exclusively create a fresh run directory; reject collisions. Only clean up the directory acquired by the current preparation attempt. Review public removal exports and ownership checks in the next pass.

## Pass 2 — Lifecycle and credential ownership

### R3 — High: cancellation does not establish container termination

Locations: `src/run.ts`, `runAgent`, `login`, and `stopContainer`.

The abort handler fire-and-forgets stop/kill; it neither waits for container creation nor verifies removal. The wrapper waits for the attached Podman client, which is not proof that the container stopped. Auth reconciliation and lock release then proceed without a verified termination barrier. Preflight also has no cancellation/deadline, and run startup can miss an abort before listener registration.

Confirmed with a deterministic fake Podman: delay container creation by 300 ms, set the run timeout to 100 ms. Calls were `info → run → stop → kill`; both termination attempts occurred before creation, and no later attempt followed. The fake container was then created and ran past the timeout. The wrapper returned after about 900 ms only because the fixture exited voluntarily.

Required direction: one shared lifecycle owner for run and login, with bounded startup/cancellation, awaited stop/force-remove, and explicit verification. Never reconcile or release a refresh lock while container termination is uncertain; report identifiable leftovers in the result.

### R4 — High: stale PID unlock permits concurrent refresh with an orphan container

Locations: `src/auth.ts`, `removeAuthProfileLock`, lock/stage metadata, and recovery functions.

A dead wrapper PID does not mean its container is dead. Neither the lock nor stage metadata records a container identity. Unlock checks only PID liveness; absent or malformed owner metadata is treated as permission to unlock. Recovery/discard never checks whether a container still mounts the stage.

Confirmed with a real, network-disabled container mounting dummy staged auth: replace the lock owner with an absent PID, run `removeAuthProfileLock`, and acquire the same profile again. Podman still reported the original container running. The test explicitly removed its container afterwards.

Required direction: associate lock/stage ownership with the exact managed container, fail closed on uncertain ownership, and verify termination before unlock/recovery/discard. Serialize profile creation too: it currently reads/writes metadata before acquiring the profile lock.

### R5 — High: trusted state and removal ownership are not enforced end to end

Locations: `src/workspace.ts`, `src/utils.ts`, `index.ts`, and `src/run.ts`.

Code inspection:

- Bind preparation accepts a directory containing the wrapper state root. For example, an explicitly project-local `XDG_STATE_HOME` can put all auth profiles and trusted run metadata inside `/workspace`. There is no overlap check before mounting.
- `index.ts` exports both guarded `removeAgentRun` and unguarded `removeRun`. The latter deletes any valid-ID directory under the resolved runs root without consulting Podman or checking `run.json` ownership.
- The runs root is canonicalized by following symlinks, not verified as the expected wrapper-owned root. Private-directory checks inspect only the final path component and do not enforce permissions on existing directories.

Confirmed in a later disposable probe: a bind mount containing the state root is accepted; making `state/pi-pod/runs` a symlink to a temporary caller-data directory allows `removeRun("not-a-run")` to delete that unowned directory despite having no run metadata.

Required direction: establish and validate canonical private state once; keep all control metadata and unrelated credentials out of every writable mount; expose one guarded removal operation. Check ownership evidence and serialize removal against preparation/launch. Reject existing unowned paths rather than inferring ownership from their location alone.

## Pass 3 — Native authentication compatibility

### R6 — High: OpenCode subscription support is explicitly disabled

Location: `src/agents.ts`, OpenCode environment.

`OPENCODE_DISABLE_DEFAULT_PLUGINS=true` disables the pinned OpenCode version's internal plugins, including `CodexAuthPlugin`. This is not equivalent to disabling external customization. The same environment is used for login and subsequent runs.

Verified against upstream source at tag `v1.18.27`, `packages/opencode/src/plugin/index.ts`: internal plugins are iterated only when `disableDefaultPlugins` is false. `--pure` separately disables external plugin origins. The built-in Codex plugin registers provider `openai` and the ChatGPT browser/headless login methods.

Required direction: retain the built-in subscription integration while disabling external discovery. Add a credential-free login-method discovery test under exactly the wrapper's startup environment; then validate real account reuse/refresh with user participation.

### R7 — Medium: the common credential validator is not an OpenCode schema

Location: `src/auth.ts`, `isCredential` and `normalizedCredentialDocument`.

The pinned OpenCode native schema uses `{ type: "api", key }`, not Pi's `{ type: "api_key", key }`; it also defines `wellknown` credentials and constrained OAuth fields. The wrapper rejects native OpenCode API credentials, while accepting arbitrary extra fields for most other credentials and copying them back verbatim. This contradicts provider-specific supported-field reconciliation.

Confirmed using a disposable OpenCode profile and a dummy native `type: "api"` entry: reconciliation throws `Invalid credential for openai.` Source reference: tag `v1.18.27`, `packages/opencode/src/auth/index.ts`.

Required direction: separate small agent-specific credential decoders/normalizers. State explicitly which provider/credential forms are supported. Construct persisted output from supported fields; do not use one permissive shared record type.

### R8 — Medium: the image's auth directories assume UID 1000

Locations: `container/Containerfile` and `src/podman.ts`.

The image creates auth parent directories owned by `node` (UID 1000), but runtime selects the host caller's numeric UID/GID. The home tmpfs/mounted-file arrangement preserves those parent directories' image ownership.

Confirmed using keep-id remapping to simulate a caller represented by UID/GID 1234, while preserving ownership of the host staged file: the pinned Pi native `AuthStorage.modify` fails with `EACCES` creating `/home/agent/.pi/agent/auth.json.lock`. The same writer succeeds with UID 1000 and persists the dummy credential through the mounted file. This is a simulated mapping test, not a second real host account.

Required direction: initialize per-run writable agent directories with the runtime UID/GID rather than image-user ownership. Test native locking/writing, not just reading the mounted file or running `id`.

## Pass 4 — CLI, package consumption, and runtime bootstrap

### R9 — High: the installed CLI runs project Bun preloads before establishing containment

Location: `src/cli.ts:1` and the package binary entry point.

The `#!/usr/bin/env bun` launcher lets Bun discover the current directory's `bunfig.toml`. A repository-defined preload runs on the host before `main`, option validation, or Podman preflight. Bun also automatically loads project `.env` files; the wrapper cannot treat values obtained afterwards as necessarily trusted host configuration.

Confirmed from a separate temporary consuming project: install the packed tarball, write a `bunfig.toml` preload that creates a harmless local marker, then run installed `pi-pod --help`. The marker is created. This needs no provider credentials or container execution.

Required direction: a CLI bootstrap that explicitly disables project runtime configuration/preloads and automatic environment discovery before application code executes. Consider an explicit-config/no-env Bun launcher or a compiled executable, and test it from a hostile fixture directory. Trusted library callers must own their runtime bootstrap; document that boundary separately.

### R10 — High: CLI validation occurs after granting workspace access

Locations: `src/cli.ts`, `main` and `requireNoFlags`.

Unknown run/dev flags are checked only after `runAgent` returns. The same final check rejects every nonempty `--` agent-argument list even though the arguments were already passed to the agent. Wrapper `--help` detection also scans arguments after `--`, stealing agent help requests.

Confirmed with a fake Podman and disposable bind workspace:

- `run ... --typo true`: Podman `run` is invoked; the CLI only then reports the unknown option.
- `run ... -- --model fixture-model`: Podman `run` is invoked; the CLI then reports that agent arguments are not accepted.

Both exit 1, potentially after modifying the project or spending provider usage. For clones, these errors occur before the CLI prints the retained workspace report.

Required direction: pure parse/validate into a complete command object before any filesystem, auth, or process side effects. Consume passthrough separately and only for dev/run. Add parser tests plus tests asserting zero Podman calls for rejected commands.

### R10 implementation decision — use Crust Core, not a custom parser

After reviewing [Crust](https://github.com/chenxin-yan/crust) at upstream commit `cb0e9f1` and published `@crustjs/core` `0.0.19`, replace the handwritten argv parser during the R10 remediation.

`@crustjs/core` provides the relevant pieces: typed subcommands, required/choice/repeated flag validation before command actions, and `rawArgs` specifically for tokens after `--`. Its documented split-command pattern also fits the review's requested legibility work. The published `0.0.19` package does not reject excess positionals/raw arguments itself, so those are checked by small command preconditions before any side effect.

Use **only `@crustjs/core`** for the application parser initially. Do not adopt `@crustjs/crust` build/distribution tooling, prompts, persistence, skills, extensions, or a plugin system: those are outside this wrapper's purpose and do not improve the container boundary. Keep the package's secure shell launcher; Crust itself documents normal Bun `.env` behavior and therefore cannot replace bootstrap containment.

Adoption prerequisites were completed in checkpoint 7: Bun is pinned at `1.3.14` for development/image use, Core is pinned exactly at `0.0.19`, and parser/action regressions run before the old parser was removed. Crust removes argv grammar code, not domain validation of workspace paths, allowed forwarded environment names, resource policy, or authentication lifecycle.

### R11 — Medium: the library contract is incomplete for automation

Locations: `src/types.ts`, `src/run.ts`, and `index.ts`.

The planned stream sinks do not exist: every launch inherits process stdio. There is no structured cleanup/auth-reconciliation status in `RunResult`; reconciliation failure becomes only an optional diagnostic, so a library caller without a callback can receive a successful result despite losing refresh persistence. Bind runs have no run ID. Exporting low-level deletion alongside guarded removal makes the safe entry point ambiguous.

Required direction: provide bounded streaming sinks and a small structured outcome that separates task termination, container cleanup, and credential persistence. Keep stdout for agent output and diagnostics distinct. Make the intended safe lifecycle API the default public surface; keep policy-bypassing internals private.

### Packaging assessment

**Local Bun consumption works, but the development/distribution contract is unfinished.**

Confirmed: `bun pm pack --ignore-scripts`, installation into a disposable Bun project, `import { runAgent } from "pi-pod"`, and installed binary `--help` all succeed. The package now ships an executable shell launcher, and a post-checkpoint disposable package-install smoke test verifies it does not load the consumer cwd's hostile Bun preload. Importing the public entry point does not launch the CLI.

Recommended finishing work:

- Decide/document local-only versus registry distribution (`private: true` currently blocks publication).
- Add an explicit package `exports`/types contract, a tested host Bun version/engine constraint, and a small `files` allowlist. The current tarball includes tests, `CLAUDE.md`, plans, and this review by default.
- Document one real install/link workflow outside this checkout and retain a pack/install/import/bin smoke test.
- Centralize the default image reference rather than repeating it in CLI and lifecycle logic. Separate package version from intentional image compatibility/version policy.
- Build with `container/` as context (or a tight context allowlist), not the entire source checkout with `node_modules` and `.git`.
- Add actionable prerequisite/profile/image errors and `--version`; avoid promising a ready subscription workflow until the authentication findings are resolved.
- Document custom-image requirements and the curated optional-extension recipe promised by the plan; they are currently absent.

## Pass 5 — Operational limits and test strength

### R12 — Medium: prerequisite and resource validation can silently weaken the stated contract

Locations: `src/podman.ts:109-120`, `src/run.ts:222-229`, and `src/workspace-usage.ts`.

- Preflight checks only the rootless flag; it does not establish native Linux/local Podman or usable cgroup resource enforcement.
- The memory validator accepts `"0"`, which means no Podman memory limit. Confirmed with fake Podman: `runAgent` succeeds and forwards `--memory 0`.
- Integer-only limits accept fractional values; library timeouts are not validated consistently with CLI timeouts.
- Workspace measurement starts after spawn, not before launch as required by the plan. Normal file churn can also trigger an immediate measurement failure on a disappearing entry.
- Staged auth is not covered by workspace monitoring. The 256 KiB read limit is a post-run parsing check, not a storage limit; the writable auth file inherits the much larger general per-file limit.

Required direction: pure, shared options validation; explicit supported-platform/preflight checks; prelaunch workspace measurement; distinguish transient disappearance from an unreadable tree. Describe and enforce the staged-file storage budget separately from its parse budget. Retain the honest warning that monitoring is not a hard aggregate quota.

### R13 — Medium: prompt-file input still exposes the entire prompt in argv

Locations: `src/cli.ts:217-232` and `src/agents.ts:39,57`.

The CLI reads the prompt file into a string, then appends that string to the Podman/agent command. This defeats the plan's stated reason for prompt-file support: keeping large or sensitive prompts out of command-line arguments. Large inputs can also hit argument-size limits.

Confirmed with fake Podman: the dummy prompt-file contents appear in the recorded Podman argv.

Required direction: use the pinned agents' supported stdin or container-local prompt-file mechanism, with bounded input and no additional implicit host mounts. Keep task text distinct from agent options, including prompts beginning with a dash.

### Existing tests are too weak to establish the security contract

The nine passing unit tests mostly cover expected-path fixtures and argv membership. The integration test checks neither native auth nor the lifecycle. Its `! touch /rootfs-write` assertion would also pass on a writable root filesystem because the non-root caller cannot write the root-owned `/` directory. The host-side check for `root/rootfs-write` does not inspect the container root at all.

Add tests in focused groups, not one giant integration scenario:

1. **Host bootstrap/Git:** hostile Bun preload and `.env`; executable Git filters/config overrides; no marker creation outside the intended container boundary.
2. **Ownership:** run-ID collision, unowned directory, symlinked state root, workspace/state overlap, active-run removal, failed preparation cleanup.
3. **Lifecycle:** pre-abort, delayed creation, timeout, failed stop, client disconnect/exit while container survives, forced removal, descendants, cleanup failure. Assert termination before auth persistence/unlock.
4. **Authentication:** native pinned writers, supported schemas, unknown fields, orphan recovery, missing/malformed lock owner, empty failed-login stage, concurrent profile creation, interrupted refresh, both UID mappings. Use fake credentials throughout.
5. **CLI/API/package:** invalid command causes zero side effects; passthrough/help; stream sinks and large output; structured cleanup/auth outcomes; packed install/import/bin usage from another project and hostile cwd.
6. **Resource/mount boundary:** zero/fractional/overflow limits; over-budget prelaunch workspace; bounded credential input; inspect actual mounts/options and attempt writes to an image path that the non-root image user would otherwise own.

## Early checks that did not reproduce a suspected failure

- Pi and OpenCode staged-file parent directories were writable by UID 1000 in the current image. Creating `auth.json.lock`, a sibling settings file, and writing the mounted `auth.json` succeeded. Therefore, do **not** report a generic UID-1000 auth-parent permission failure.
- The pinned Pi native writer has now been exercised successfully with dummy credentials at UID 1000. It writes in place; do not report an assumed atomic-rename mount incompatibility for this version.
- Real OAuth login/refresh remains untested. OpenCode's pinned auth source calls its filesystem helper's in-place JSON writer; an actual native OpenCode credential-write smoke test is still desirable.

## Readability and module boundaries

The small package/direct-Podman approach is worth keeping. The problem is not a need for a framework: too many safety decisions are interleaved in long workflows, while helpers with materially different trust assumptions share generic names.

### Extract by responsibility, not an arbitrary line count

Make these splits incrementally while fixing their associated findings:

| Domain-facing module | Keep its focus here | Extract elsewhere |
| --- | --- | --- |
| `run.ts` | Readable order: validate → prepare → acquire auth → execute → verify termination → reconcile → report retention | Shared container lifecycle into `container/lifecycle.ts`; limit/default validation into `options.ts`. Login should use the same lifecycle owner, not a second signal implementation. |
| `auth/profiles.ts` | Profile selection and high-level credential-session workflow | Agent-specific schemas in `auth/credentials.ts`; exclusive ownership in `auth/lock.ts`; staging and recovery together in `auth/staging.ts`. Locks/recovery are safety-critical domain code, not miscellaneous utilities. |
| `workspace.ts` | Bind versus clone policy, ownership acquisition, retained-workspace rules | Controlled Git operations in `workspace/git.ts`; canonical state paths and ownership evidence in `state.ts`. Keep destructive deletion private behind the ownership-aware operation. |
| `cli.ts` | Minimal bootstrap/error reporting | Pure parsing/validation in `cli/parse.ts`; small command handlers in `cli/commands.ts`; help text separate if it obscures parsing. Parse into a discriminated command object before dispatch. |
| `podman.ts` | Auditable, explicit argument construction | Prerequisite checks in `container/preflight.ts`; process execution in the shared lifecycle module. Keep security switches visible rather than hiding each behind tiny wrappers. |
| General helpers | No domain policy | Replace `utils.ts` with narrowly named `utils/fs.ts`, `utils/process.ts`, and only genuinely shared error/type guards. Do not create a catch-all dumping ground. |

This is a responsibility map, not a request to generate every file at once. A short cohesive function is preferable to a chain of one-line indirections. A reviewer should be able to read lifecycle ordering in one place without following filesystem/parsing details.

### Types and naming should carry invariants

- Make `PreparedWorkspace` a discriminated union: owned clones require their ID/baseline; bind workspaces cannot accidentally claim ownership. Avoid `owned: boolean` plus optional metadata and non-null assertions.
- Use explicit cleanup and credential outcomes. `process.exited`, `containerStopped`, and `containerRemoved` are different facts; name them accordingly.
- Avoid no-op abstractions such as `parseAuthProfile`, which returns its input unchanged, or `string | "none"`, which is just `string`.
- Replace repeated nested ternaries and immediately invoked throwing expressions with simple branches when that makes policy easier to scan.
- State-path resolution and environment snapshots should be explicit per operation, rather than mixing module-load snapshots with later reads of mutable global environment.

### Comments should explain the safety reason

Prioritize comments at these boundaries:

- Why source Git inspection must not execute repository-controlled configuration on the host.
- Why only exclusively acquired run directories may be deleted by preparation cleanup.
- Why container termination must be verified **before** reading refreshed credentials or releasing the lock.
- Which pinned native credential writer/locking behavior a file mount relies upon, and which test must pass when upgrading the agent.
- What failures preserve staging/workspace state, and how the caller finds/reconciles leftovers.
- Where pathname traversal or monitoring is not a hard security/disk guarantee.

Do not add narration to obvious assignments. Correct misleading names/comments first: a leaf-only check is not full private-state validation, and a stat followed by unrestricted `readFile` is not a race-proof bounded read. Security-sensitive reads should open without following symlinks, verify the descriptor, and read at most the configured bound.

## Remediation order and review gates

1. **Host execution boundary:** R9 and R1. Gate: hostile cwd/runtime/Git fixtures produce no host-execution marker.
2. **Ownership and lifecycle:** R2–R5. Gate: collisions never erase work; every exit either verifies container removal or reports/quarantines a leftover without releasing credentials.
3. **Native auth compatibility:** R6–R8. Gate: pinned native writers and login-method discovery work under the exact restrictions and both UID mappings; then user-assisted OAuth reuse/refresh.
4. **Public contract and operational correctness:** R10–R13. Gate: validation precedes effects; prompt/streams/results and limits behave as documented.
5. **Package/docs polish:** explicit supported public surface, installation workflow, small tarball/build context, custom-image guidance, and tested examples.

After each gate: update this document, add focused regression tests, run `bun test`/typecheck, and review that small diff before continuing. Do not do a sweeping structural rewrite and all safety fixes in one unreviewable change.

## Remaining manual validation

- Real subscription login, reuse, token rotation, callback/device flow, and interrupted refresh with user participation. The README supplies a disposable-profile procedure which records only provider, exit status, and reuse/refresh result.
- Native terminal resize/Ctrl-C and a genuinely non-1000 host account (the review used UID remapping).
- SELinux-enforcing hosts, unsupported/remote Podman failure paths, and quota-backed storage if a hard aggregate disk guarantee is desired.

No personal credential values were inspected. Probes used fake tokens/temporary repositories and explicitly cleaned up their containers. Checkpoint 1 made only the documented launcher and safe host Git-inspection changes; no orchestrator changes were made.
