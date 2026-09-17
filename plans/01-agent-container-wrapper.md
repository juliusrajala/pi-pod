# Agent container wrapper: implementation plan

**Status: historical implementation record.** The documented wrapper, image, local clone, staged credentials, CLI, and automated tests were implemented in later checkpoints; user-assisted real-account login/refresh remains a manual validation. No orchestrator changes were made. Current behavior and maintained limits are in [the documentation index](../docs/README.md); this plan preserves its original decisions and proposals.

## Goal

Make `pi-pod` a small Bun/TypeScript module and CLI for running Pi or OpenCode inside a rootless Podman container, either interactively or under an orchestrator.

The module owns the execution boundary: workspace preparation, container configuration, process lifecycle, and cleanup. It does **not** own the agent's development workflow or decide what happens to its changes.

## What exists today

I inspected `../home-infra/agent-orchestrator/`, especially:

| Existing file | Responsibility | Proposed disposition |
| --- | --- | --- |
| `Containerfile.pi-runner` | Node, Bun, Git, shell tools, Pi | Adapt into a standalone runner image |
| `src/orchestration/runner.ts` | Hardened Podman arguments and process launch | Extract the general behavior |
| `src/orchestration/repository.ts` | Disposable clone, remote branch selection, publishing prerequisites | Reuse the independent-clone idea; leave remote/publishing policy behind |
| `src/orchestration/workspaceUsage.ts` | Aggregate disk-usage monitoring | Adapt, retaining its explicit limitations |
| `scripts/runner-entrypoint.sh` | Runs Pi, commits changes, exports patches | Do not copy wholesale; automatic commits are inappropriate for a general local wrapper |
| `src/orchestration/jobs.ts`, `github.ts` | Job history, timeouts, recovery, draft PR publishing | Leave in the orchestrator; extract only generic timeout/termination behavior |

The current temporary workspace is a **fresh clone from the remote at a recorded commit**, not a snapshot of the local folder. It requires a clean source checkout and GitHub publishing credentials. Those requirements should not become requirements for using this module locally.

Useful existing protections include rootless execution, dropped capabilities, a read-only root filesystem, bounded temporary directories, and narrowly forwarded credentials. We should preserve them while fixing assumptions such as the caller having UID 1000, unpinned Pi installation, and Pi-specific startup behavior.

## 1. Keep the architecture small

Use one package with a reusable library and a thin CLI. Invoke the installed `podman` executable using argument arrays and `Bun.spawn`; do not build shell command strings.

Proposed layout:

```text
index.ts                    public library exports
src/cli.ts                  secure bootstrap only; restores caller context
src/cli/app.ts              Crust application composition root
src/cli/commands/           one small Crust action per command
src/run.ts                  lifecycle orchestration, cancellation, results
src/options.ts              pure resource and timeout validation
src/prompt.ts               bounded private task staging
src/podman.ts               validated container configuration and commands
src/workspace.ts            workspace ownership, clone preparation, removal
src/agents.ts               small Pi/OpenCode launch definitions
src/auth.ts                 stable public auth facade
src/auth/profiles.ts        persistent selected-provider profile storage
src/auth/lock.ts            exclusive profile lock ownership/release
src/auth/staging.ts         temporary mounted state and recovery
src/auth/credentials.ts     agent-specific credential normalization
src/workspace-usage.ts      storage monitoring
container/Containerfile     shared development image
plans/                      design decisions
```

Tests can live alongside the corresponding source files.

**Why:** shell scripts alone become awkward once we need typed options, cancellation, cleanup, and an importable API. A container SDK, daemon, plugin framework, or Pi extension would add machinery without improving this boundary. Running the entire agent inside the container also contains extensions and subprocesses, rather than trying to intercept individual tools.

Initial supported host: native Linux with local rootless Podman and working cgroup resource limits. Fail clearly on unsupported setups rather than silently dropping protections. Podman Machine, remote Podman, Docker, and Kubernetes are later concerns.

## 2. Two explicit workspace modes

### `bind`: work directly in a folder

Mount the selected folder read/write at `/workspace`. Ordinary folders and conventional Git repositories are supported; uncommitted changes are fine.

- The agent changes the real files immediately.
- Never automatically commit, reset, clean, or delete this folder.
- Do not mount its parent or the user's home to make missing files available.
- Reject external Git metadata, such as a linked worktree whose `.git` points outside the mount, with an actionable explanation. Do not quietly mount the parent repository.

**Why:** this is the natural human-led workflow: the editor and agent see the same files. It protects the rest of the host, not the selected project. Files already inside the mount—including `.env`, credentials, and Git configuration—are accessible to the agent.

### `clone`: work in an independent disposable checkout

For the first version, require a clean local Git repository and clone its **local HEAD**, including committed but unpushed work, into a private run directory outside the source tree. Record the starting revision and create a run-specific branch.

- No remote access or forge credential is required.
- Use an independent clone, not a Git worktree, hardlinked copy, or shared object store.
- Do not inherit source hooks, credential helpers, or arbitrary local Git configuration.
- Omit untracked/ignored files and installed dependencies.
- Reject dirty repositories instead of silently losing local edits.
- Initially reject repositories requiring unsupported external metadata, submodule materialization, or Git LFS handling rather than producing a misleading partial workspace.
- Git preparation must use a controlled environment and disable hooks and other executable Git customization. Repository installs and validation run only inside the container.

**Why:** this closely follows the useful part of the orchestrator's approach, preserves Git history, and gives an understandable starting point without needing GitHub. A worktree is cheaper but shares mutable Git metadata with the source.

**Confirmed scope:** isolation from the last local Git commit is sufficient; dirty/non-Git snapshots are not required in v1. Naming the mode `clone`, rather than `copy`, avoids implying that local edits are included. Direct mounting still supports dirty folders.

An orchestrator can later prepare its own remote-based checkout and pass that directory using `bind`; here, `bind` means “use the caller's directory,” not necessarily “use a human's live checkout.”

## 3. A small, predictable CLI

Illustrative interface:

```bash
# One explicit image build; no surprise image builds during automated jobs.
pi-pod build

# Authenticate once using the agent's native subscription login flow.
# No project is mounted during login. Each agent has its own default profile.
pi-pod login --agent pi
pi-pod login --agent opencode

# Human-led development: direct mount, native agent TUI, saved credentials.
pi-pod dev .
pi-pod dev . --agent opencode

# Interactive development in an isolated clone instead.
pi-pod dev . --workspace clone

# Automation: clone by default, no TTY, bounded runtime, saved credentials.
pi-pod run . --prompt "Fix the failing unit tests"

# Caller has already prepared an isolated checkout.
pi-pod run /path/to/job/checkout --workspace bind \
  --prompt "Implement the requested change"

# API keys remain an alternative; disable saved auth explicitly here.
# Agent-specific flags stay agent-specific.
pi-pod dev . --auth none --env OPENAI_API_KEY -- --model openai/model-name

# Explicitly discard a retained clone after reviewing/recovering its work.
pi-pod remove <run-id>
```

Pi is the default agent. `dev` defaults to `bind`; `run` defaults to `clone`. Both allow an explicit override. Calling `pi-pod` alone prints help rather than unexpectedly granting write access.

Common options cover agent, workspace mode, image, authentication profile (`--auth <name>` or `none`), credential environment names, resource limits, and timeout. Use the agent's wrapper-owned default auth profile when one exists; never discover credentials from the user's personal agent installation. Support a prompt file for automation so callers need not place large or sensitive prompts in command-line arguments. Paths passed through to the agent are container paths; do not silently expose extra host files.

The wrapper prints the selected workspace mode and mounts before starting. Agent output remains on stdout; wrapper diagnostics go to stderr. A result-file option can provide machine-readable lifecycle metadata without mixing wrapper JSON with agent output.

Start with flags and explicit library options, not executable project configuration or automatic repository-defined Podman settings. A declarative user configuration file can be added once repeated settings justify it.

## 4. One image, two small agent definitions

Build a shared image containing Pi, OpenCode, Bun, Node where required, Git, bash, ripgrep, certificates, and basic development utilities. Pin agent and runtime versions; use a versioned image tag rather than an implicit `latest`. Keep build inputs separate from the user's project, and never bake in credentials.

**Why one image:** initially there is one toolchain to build, debug, and secure. The extra installed CLI is a reasonable tradeoff for avoiding an image matrix. Advanced projects can supply a compatible custom image; the same runtime restrictions still apply.

Each agent definition supplies only its executable, interactive/headless arguments, container-local state paths, and supported startup settings:

- **Pi:** native TUI for `dev`, print mode for `run`.
- **OpenCode:** native TUI for `dev`, `opencode run` for `run`.
- Pass through agent-specific arguments; do not invent a common model, tool-event, or conversation API.
- No automatic Git commits or patch capture in the default entrypoint. Prefer direct execution under a container init process that handles child reaping and signals.

Use a fresh container-local home/configuration for each run, populated only with the selected credentials and wrapper-owned startup settings. Do not import the user's host extensions, plugins, MCP servers, or shell configuration. For headless runs, disable automatic project customization where supported and configure permission handling explicitly so jobs do not wait for nonexistent approval input. Interactive runs can use the agent's native trust/approval flow inside the container. Verify that disabling external customization does not disable built-in subscription authentication, particularly OpenCode's provider integrations.

Pi's discovery/trust flags and OpenCode's plugin/config/permission controls differ. Verify the pinned versions, including OpenCode's merged project configuration; setting a custom config path alone does not exclude project settings. Do not claim identical controls or treat agent permission settings as the sandbox.

### Compatibility with the personal `../pi-files/` package

Inspection of its source and example configuration—not private auth files—suggests **ChatGPT/Codex (`openai-codex`) should be our first subscription target**. `extensions/auto-model.ts` explicitly selects models from that provider. This is evidence of the intended provider, not proof of the currently authenticated account. Do not hardcode its personal model IDs into the wrapper.

The package is separate from credentials and should remain separate from `pi-pod`:

| Resource | Container implication |
| --- | --- |
| `auto-model.ts` | Portable model selection; optional interactive customization. Its disabled-repository list uses host absolute paths and its config path is under `HOME`, so blindly copying host settings will not preserve that behavior at `/workspace`. |
| `git-operation-permission.ts` | Useful optional interactive confirmation. It intentionally denies commits/pushes without a UI, so do not load it into automated runs by default. Its shell matching is a convenience guard, not the containment boundary. |
| `omarchy-system-theme.ts` | Reads a desktop theme marker under host configuration. Leave it out; use a container-local Pi theme rather than mounting desktop configuration. |
| `pi-usage-analytics.ts` and report skill | Need persistent analytics and, for some reports, session data. Leave disabled until persistence is explicitly designed; credential persistence does not provide analytics persistence. |
| `swarmia-ai-usage.ts` | Needs a separate token and uploads usage. Do not import its configuration, forward its token, or enable reporting automatically. |

The manifest discovers all extensions, while `config/settings.json.example` filters them. Consequently, loading the package root is not equivalent to preserving the user's selected extensions. The example also does not prove which resources are currently enabled.

Keep the v1 default clean. For opt-in personalization, document a curated custom-image recipe using explicit extension paths (Pi supports disabling discovery while loading named extensions). Include only reviewed source/dependencies; no personal `node_modules`, credentials, or runtime state. A convenient read-only package-mount option can follow, but no hard dependency on `pi-files` or automatic host-package import is needed now. Any chosen extensions still run entirely inside the sandbox.

Before enabling these extensions, smoke-test against the image's pinned Pi version: `pi-files/package.json` currently pins development types to `0.84.4`, whereas the installed Pi documentation inspected here is `0.85.1`. Do not assume compatibility or modify the personal package as part of this extraction.

## 5. Security contract: containment, not a sealed vault

Apply the same baseline in both workspace modes:

- Rootless Podman, a non-root container user, and explicit UID/GID mapping so host files retain the caller's ownership. Test callers whose UID is not 1000.
- Read-only root filesystem; writable `/workspace`, bounded temporary home and `/tmp`, plus a narrowly scoped, size-limited per-run authentication staging directory when using saved credentials.
- Drop all capabilities, enable `no-new-privileges`, retain Podman's default seccomp/SELinux confinement, and use private process namespaces.
- No privileged mode, host networking, container socket, SSH agent, desktop socket, or implicit home mount. No arbitrary Podman-argument escape hatch in v1.
- Preserve the existing starting limits: 4 GiB memory, 4 CPUs, 512 processes, and 512 MiB each for home and `/tmp`; allow explicit validated overrides.
- Use rootless `pasta` networking with automatic port forwarding disabled. No published ports by default. Offer `network=none`; local preview port publishing can follow as an explicit feature.
- Use private SELinux relabeling for owned clones where needed. Do not automatically apply recursive `:Z` relabeling to a live project; provide an explicit, documented labeling choice or fail with guidance.
- Pass only explicitly selected environment variables, not the complete host environment. Sanitize host helper-process environments too: Bun may have loaded the current project's `.env`.
- Keep run-control metadata outside agent-writable mounts. Treat everything written by the agent as untrusted, including `.git` and any eventual patch or result artifact.

Monitor writable workspace usage and retain a hard per-file size limit, with an initial 4 GiB workspace budget that can be increased explicitly. Measure before launch and stop runs whose usage exceeds the budget or becomes unmeasurable. Use traversal that does not follow symlinks outside the workspace.

**Limits we must document honestly:**

- A writable bind mount allows destructive changes and planted code/hooks that the human may execute later.
- Network-enabled containers can exfiltrate visible data and reach network services, potentially including host/LAN services. `pasta` is not an egress allowlist.
- Credentials provided to the agent are also available to code it runs. Environment filtering does not hide a model key from dependency scripts.
- A size monitor can overshoot between checks, and a per-file limit is not a total disk quota. Hard aggregate storage limits require a quota-backed filesystem.
- Containers share the host kernel; this reduces blast radius, not every risk of hostile code.

## 6. Subscription authentication is a v1 requirement

**Confirmed:** the wrapper must work with the user's subscription, not just API keys. Based on `pi-files/extensions/auto-model.ts`, use **ChatGPT/Codex (`openai-codex` in Pi)** as the initial login/refresh acceptance target, subject to correction if the actual account differs. Verify OpenCode's corresponding native provider flow separately; provider identifiers and credential formats need not match. Do not assume every subscription is supported by both agents or billed the same way.

### Separate interactive host credentials from autonomous profiles

`pi-pod login --agent pi|opencode` remains the native-login path for wrapper-owned autonomous profiles. It runs the agent's authentication flow in a clean container with no project mounted. Pi uses its `/login` flow; OpenCode uses its native provider login command. The wrapper stores only selected credentials; it does not implement OAuth or translate credentials between agents.

Interactive Pi `dev` is intentionally different: it reads only the existing host `~/.pi/agent/auth.json` `openai-codex` credential, validates and stages a private copy for that session, and never mounts or writes the host Pi directory. It additionally mounts trusted direct extension directories and local extension package roots read-only through a filtered generated settings file, which carries only extension declarations plus default provider/model/thinking preferences; it does not mount general Pi settings, sessions, analytics, skills, themes, or unrelated configuration. This lets the local developer use their Codex subscription and extensions without a second container OAuth flow. Headless/autonomous `run` never reads the host Pi login or extensions; it uses a wrapper-owned profile or an explicit API key. Never mount all of `~/.pi/agent` or OpenCode host data/configuration.

Browser authentication needs an explicit container-aware path: prefer the provider's device-code or copy/paste flow. If the selected provider requires a callback listener, validate a login-only loopback port mapping; do not enable host networking or desktop socket access. Document the exact tested flow rather than assuming a browser callback can reach container localhost.

### Persist refreshed tokens without persisting arbitrary configuration

For each autonomous profile run:

1. Acquire an exclusive host-side lock for the selected profile and stage only its native credential data into private per-run storage, outside the project. Map it into the agent's otherwise fresh configuration/data locations, allowing the native writer's locking and file-replacement behavior.
2. Let the agent perform authentication and token refresh itself. Credentials must be writable inside the stage.
3. After the container stops, validate and atomically save only the supported provider credential fields back to that wrapper-owned profile, even if the task failed or was cancelled. Never copy back settings, extensions, command-valued auth entries, sessions, or arbitrary files.
4. Remove staged credentials after successful reconciliation. Keep pending refresh data private and separate from retained workspace artifacts if interrupted; reconcile it before allowing that profile to run again. Do not overwrite newer tokens with a stale copy.

A host-sourced interactive Pi dev stage is source-only: it is writable inside the container so Pi can operate normally, but no agent change is copied back to host Pi auth. A provider may rotate a token server-side, so a later host Pi login can require reauthentication.

**Simple initial concurrency rule:** only one active run/login per auth profile; reject concurrent use with a clear message. This avoids competing refreshes without adding a credential broker. Parallel shared-subscription runs need deliberate follow-up work before orchestrator migration.

Treat staged auth as untrusted input: bounded parsing, regular-file/no-symlink checks, an agent/provider-specific schema, and no host-side evaluation. Validation cannot prove that tokens are genuine, and the agent can still read, alter, or leak the credentials it receives. This isolates the rest of the host and unrelated accounts; it does not hide the selected subscription credential from repository code.

API keys remain supported through explicit environment forwarding, for example `--auth none --env ANTHROPIC_API_KEY`. Forward values through the subprocess environment rather than putting secrets in command arguments. Redact wrapper-owned diagnostics; never automatically forward forge or database credentials or promise to scrub arbitrary agent output.

**Separate concern:** credentials persist in v1; conversation history/resume and general agent configuration do not yet persist. Local model servers remain a future opt-in network/configuration feature, not a reason to defer subscription support.

**Why:** this adds the authentication needed for daily use without turning the sandbox into another process with access to the user's entire personal agent installation.

## 7. Lifecycle and ownership must be explicit

The library exposes a typed `runAgent(options)` operation with workspace mode/path, agent arguments, explicit environment, stream sinks, timeout, and `AbortSignal`. Return run ID, actual workspace path, exit code, termination reason, and retention/cleanup information. The CLI should use this same API.

These are trusted host-caller options, not a model-facing tool schema. A future orchestrator must still authorize workspace paths, images, credentials, and options; it must not pass arbitrary agent requests straight into this API.

- Interactive execution inherits terminal streams and supports resize and Ctrl-C correctly. Headless execution has no TTY and streams output without unbounded in-memory buffering.
- Interactive runs have no default wall-clock timeout; automated runs initially use the existing ten-minute default, configurable by the caller.
- Cancellation and timeout stop the **container**, not just the attached Podman client. Allow a bounded grace period, force termination if needed, then verify removal. Handle cancellation during preparation/startup too.
- Give containers unique names and ownership labels. Report identifiable leftovers if removal fails; never run a broad `podman prune`.
- A failed agent run is different from setup failure, cancellation, timeout, or a resource limit. Cleanup errors must not overwrite the primary outcome.

### Preserve work before optimizing cleanup

Store owned clones under `$XDG_STATE_HOME/pi-pod/runs/<run-id>` (with the standard home fallback), using private permissions. They are disposable workspaces, but not placed somewhere subject to arbitrary `/tmp` cleanup.

For v1, **retain clones after every launched run**, successful or not, and print the location/run ID. Never automatically copy changes back or assume that exit code zero means the work is safe to delete. Partial preparation can be removed if the agent never started.

`remove <run-id>` and the corresponding library cleanup operation remove only wrapper-owned run directories after verifying the container is stopped. Validate IDs, ownership, canonical paths, and symlink boundaries; never accept an arbitrary deletion path or infer ownership from agent-written metadata. Caller-owned bind directories are never removed.

**Why:** retaining a checkout is a simpler, loss-resistant first result format than automatic commits, patch export, change detection, and synchronization. The orchestrator can later add its publishing lifecycle without forcing that policy on local users.

## 8. Implementation sequence and checks

### Step 1 — Container foundation

Implement the image, option validation, Podman argument construction, rootless preflight, and agent definitions.

**Done when:** both agents start in the hardened image; Bun/Git work; non-1000 UID ownership works; missing prerequisites fail clearly rather than degrading security.

### Step 2 — Subscription login and interactive bind workflow

Implement the library lifecycle, credential profiles, `login`, and `dev`, including native terminal handling. Start with the ChatGPT/Codex flow indicated by `pi-files` and test its container-aware login path in both agents.

**Done when:** an autonomous login survives container exit and a later autonomous run can authenticate with its persisted profile; interactive Pi dev stages the selected host credential without mounting or writing host Pi configuration; edits appear in a temporary host fixture; the agent cannot see a sibling sentinel file or host home; resize/Ctrl-C work; exit leaves no running container and never removes the bound folder.

Use fake credentials to test refresh persistence after success, task failure, cancellation, and interrupted reconciliation; concurrent profile use; malformed/symlinked credential files; and exclusion of agent-written settings. Real login/refresh smoke tests require the user's participation and must not record tokens.

### Step 3 — Independent clone workflow

Implement clean-local-HEAD preparation, recorded baseline, retention, and guarded removal.

**Done when:** local unpushed commits are included; dirty inputs are rejected; source files and Git metadata remain unchanged; the clone has no shared objects, hooks, or source secrets from ignored files; work survives failure and cancellation.

### Step 4 — Headless execution and operational limits

Implement `run`, prompt-file input, streamed output, result metadata, storage monitoring, timeout, and abort handling.

**Done when:** both agents support an unattended run; outputs do not deadlock or grow memory unboundedly; timeout/abort kills descendants in the container; resource and cleanup failures are reported distinctly.

### Step 5 — Document and validate the public contract

Write the quickstart, library example, custom-image requirements, security limits, and recovery/removal instructions. Verify the package can be imported from another Bun project without triggering CLI behavior.

Use `bun test` for unit tests and temporary Git fixtures, plus typechecking. Add opt-in Podman integration tests using harmless fixture commands/fake agents: mounts, environment isolation, read-only root, ownership, network settings, cleanup, signals, symlinks, invalid paths, large output, and concurrent runs. Real-agent startup/TUI smoke tests are separate; paid provider tests require explicit opt-in and never use production repositories or forge credentials.

## 9. Future orchestrator adoption—not part of this implementation

Once the local wrapper is stable:

1. Have the orchestrator consume the library and versioned image.
2. Initially keep its remote branch selection and workspace preparation; pass its prepared clone as a caller-owned directory.
3. Replace its Podman launch/stop/limit handling with this module.
4. Design an explicit, credential-free change-capture step inside the sandbox before replacing the current entrypoint. Capturing changes must not execute agent-modified Git configuration on the trusted host.
5. Keep database state, capacity, task prompts, retries, recovery policy, notifications, forge credentials, and PR publishing in the orchestrator.

No migration, daemon, PR automation, automatic merge-back, shared package caches, persistent agent server, RPC protocol abstraction, or multi-container development environment in v1.

## Review decisions

Confirmed by the user:

1. **Isolation can start from the last local Git commit.** Dirty/non-Git snapshots are not required in v1.
2. **Subscription authentication is required in v1.** API-key-only support would not meet current needs.

Remaining recommendations:

- **Distribution is local-only for v0.1.** Keep the package private; use a source checkout, local tarball, or local Bun link. Registry publication is deferred.
- **`dev` binds; `run` clones.** Both modes remain explicitly selectable.
- **Use the host Codex credential only for interactive Pi dev.** Stage a validated source-only copy, never the personal agent home. Autonomous profiles use native subscription login and persist their own refreshes; initially allow one active run per profile.
- **Retain clones until explicitly removed.** No automatic commit, publish, or copy-back behavior.
- **Keep conversation resume separate.** Persistent credentials do not require persistent chat sessions.

Initial subscription target inferred from `pi-files`: **ChatGPT/Codex**, using Pi's `openai-codex` provider and OpenCode's corresponding native integration. Pi's current OAuth source confirms a device-code flow and `auth.json` OAuth schema; autonomous profiles stage and reconcile only that selected Pi credential. Actual account login/refresh verification still needs the user's participation; README provides a disposable-profile procedure that records no credential values. Interactive dev explicitly loads trusted host extensions through read-only, filtered mounts rather than importing general host configuration. Orchestrator adoption remains deferred.
