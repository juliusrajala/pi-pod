# Human-readable architecture, agent configuration, and documentation

**Status: proposed; no runtime changes authorized by this document alone.**

## Goal and scope

Make pi-pod understandable to a maintainer who did not build it, convenient for daily development, and straightforward to extend with another reviewed agent. Keep it a small execution boundary, not a plugin platform or orchestrator.

This plan follows [Plan 02](02-readability-and-autonomous-validation.md), rather than repeating its completed workspace/process splits. [Plan 01](01-agent-container-wrapper.md) and [the adversarial review](../reviews/01-adversarial-review.md) remain security history. [Plan 03](03-analysis-trace-delivery.md) is independent, opt-in analysis work; this plan neither implements it nor enables it through configuration.

The scope is source organization, explicit per-agent capabilities, optional declarative preferences, and maintained user/contributor documentation. Preserve existing behavior and defaults during structural refactoring; introduce configuration features in separately reviewed checkpoints.

## 1. Findings from the current structure

| Area | What works | What makes it harder to understand or extend |
| --- | --- | --- |
| `bin/pi-pod`, `src/cli/bootstrap.ts` | Explicit protection against workspace-controlled Bun startup | This critical entry-point contract is easy to miss when adding command examples or convenience wrappers. |
| `src/agents.ts` | Small agent launch definitions; no heavyweight abstraction | Pi versus OpenCode branching is repeated in launch, prompt-file execution, and login. The non-Pi branch implicitly means OpenCode. |
| `src/auth/credentials.ts`, `host.ts`, `staging.ts`, `src/run/credentials.ts` | Credential decoding, storage, locks, and staging are mostly separated | A new agent needs changes across provider rules, host paths, source identifiers, defaults, and launch state paths. Generic staging still names individual agents. |
| `src/run.ts` | Shared container lifecycle is already extracted | Run, login, and retained-run deletion still share one file. Resource acquisition and a large `finally` block mutate a previously constructed result; cleanup dependencies require careful tracing. |
| `src/podman.ts` | Hardening switches are visible in one argv list | It also owns preflight and environment policy, and its generic launch options contain Pi-specific extension/settings fields. |
| `src/dev-resources.ts` | Explicit filtered, read-only Pi resources | The generic filename hides that this is Pi-only. Host model preferences and extension package selection are coupled. |
| `src/types.ts`, CLI commands, help, build | Small public API and strict Crust argument parsing | Auth defaults are resolved in both CLI and library code; image references repeat. `string \| "none"` adds no type information; workspace ownership is a boolean plus optional fields. |
| Tests | Strong fake-Podman and adversarial fixtures | `src/run.test.ts` mixes many scenarios and repeats fake-process setup. New agent coverage is not organized as a reusable contract. |
| Documentation | README explains important boundaries | Quickstart, auth, recovery, API, and security compete for attention. Historical plans and instructions can contradict newer behavior. No maintained agent support matrix or contributor recipe exists. |

Do not optimize for minimum file length. The objective is fewer places to inspect for one question, with execution and cleanup order still visible in one place.

## 2. Vocabulary and ownership

Use these terms consistently in code, help, and docs:

| Term | Meaning |
| --- | --- |
| Agent | Container executable and its integration, such as Pi or OpenCode. |
| Provider | Agent-native model/auth identifier; Pi `openai-codex` and OpenCode `openai` are not interchangeable. |
| Auth source | Host credential, wrapper-owned profile, or none; separate from preferences. |
| Auth profile | Persistent selected-provider credentials owned by pi-pod, not native chat history or a general settings bundle. |
| Agent preferences | Non-secret model/behavior choices validated for one agent and one mode. |
| Execution policy | Workspace ownership, allowed mounts/environment, network restrictions, limits, and cleanup; owned by pi-pod, not configurable by an agent adapter. |
| Image | Pinned runtime implementation of supported agents; host CLI versions do not change container versions. |

## 3. Small explicit agent integrations

### Recommended structure

Replace growing binary conditionals with a closed, statically imported registry. Keep only Pi and OpenCode in it initially.

Illustrative destination layout, to be introduced incrementally:

```text
src/
  agents/
    contract.ts              small internal capability/launch types
    registry.ts              explicit IDs, lookup, unknown-agent rejection
    pi/
      definition.ts          commands, fixed environment/state paths, capabilities
      credentials.ts         pure native credential decoder/normalizer
      dev-resources.ts       existing filtered Pi resource implementation
    opencode/
      definition.ts
      credentials.ts
  auth/
    credentials.ts           bounded document parsing + selected-provider dispatch
    host.ts                  approved host-path resolution and bounded reads
    profiles.ts              persistent profile metadata and storage
    lock.ts                  exclusive profile ownership
    staging.ts               stage, reconcile/discard, guarded recovery
  run.ts                     public run orchestration
  run/
    options.ts               pure resolution of defaults and credential policy
    credentials.ts           acquire/stage chosen source
    finalize.ts              explicit finalization only if it improves readability
  login.ts                   profile-login orchestration using shared lifecycle
  container/
    lifecycle.ts             existing process/container ownership
    preflight.ts             platform/rootless/cgroup checks
    environment.ts           forwarding validation and sanitized client environment
  podman.ts                  explicit hardened argv and approved mount construction
  defaults.ts                shared image/runtime defaults, not arbitrary config
```

Retain the current CLI, workspace modules, public `index.ts`, and filesystem primitives unless there is a concrete responsibility problem. Retained-run removal should have a clear entry point near workspace ownership, without creating circular imports. Preserve public exports even if internal files move.

### Adapter contract

A definition should describe only reviewed differences:

- Agent ID and interactive/headless support.
- Container-local credential location and fixed startup environment.
- Command construction, prompt transport, and native login instructions.
- Supported native credential decoding and optional host-auth capability.
- Optional interactive preference/resource support, with Pi-only features labeled as such.

Host-auth capability describes the selected provider and an approved path strategy, not a user-supplied arbitrary credential path. Read host files only in the host-auth coordinator after validating mode and source. Do not resolve paths or read environment/files when importing the registry.

Keep pure per-agent code independent of auth storage and container execution. The dependency direction should be:

```text
CLI / trusted library input
  → resolved run policy
  → selected agent definition + validated preferences
  → workspace/auth/resource preparation
  → hardened Podman argv → shared lifecycle → guarded finalization
```

No adapter may spawn host commands, return arbitrary Podman flags, disable resource enforcement, request an entire host home, or install itself on the host. Unsupported capabilities fail explicitly; do not silently fall back to another agent or interactive mode.

For development defaults, use host auth only for agents with a reviewed host-auth capability. A future agent without one must give an actionable choice of explicit token/profile rather than discovering credentials or failing deep in staging.

Do not generalize every agent difference. Shared prompt transport may remain a small fixed helper if its quoting/newline invariants stay auditable. Preserve the distinction between container-local prompt argv and the host Podman argv.

## 4. Per-agent configuration: separate policy from preferences

There are three different proposals here; do not conflate them:

1. **Built-in integration definitions:** reviewed TypeScript in `src/agents/`; implement first.
2. **Repository-maintained examples and documentation:** non-secret examples under `config/agents/` with a schema/version and per-agent explanation; implement next.
3. **User-supplied preference files:** optional feature with validation and explicit loading; implement only after the schema and precedence are reviewed.

### Agreed v1 configuration design

Use one bounded, declarative JSON configuration file with the same high-level structure for each agent and separate agent-specific preferences and resources. JSON avoids an executable configuration system or another parser dependency. This is an approved design, **not a claim that the loader or resource support is implemented**.

```json
{
  "version": 1,
  "agents": {
    "pi": {
      "dev": {
        "model": { "provider": "openai-codex", "id": "<model-id>" },
        "preferences": { "thinking": "high" },
        "resources": { "extensions": [], "skills": [] }
      }
    },
    "opencode": {
      "dev": {
        "model": { "provider": "openai", "id": "<model-id>" },
        "preferences": { "variant": "high" },
        "resources": { "plugins": [], "skills": [] }
      }
    }
  }
}
```

A copyable design example is in [04-agent-configuration.example.json](04-agent-configuration.example.json). Model IDs are placeholders; preference and resource support must be verified for the pinned agent and selected mode before shipping. The example includes empty resource arrays deliberately: they mean disabled, not inherited defaults.

Schema rules:

- `version` is required and initially `1`; other fields are optional. Reject unknown fields and unsupported versions.
- Each agent has independent optional `dev` and `run` sections with the same envelope: `model`, `preferences`, and `resources`. No shared section or implicit mode inheritance initially.
- A supplied `model` requires both nonempty `provider` and `id` strings. Resolve it atomically, never combine an inherited provider with an unrelated explicit model ID.
- Translate the common model object into Pi's separate provider/model arguments or OpenCode's native `provider/model` form. Provider IDs remain agent-native.
- Start with Pi `preferences.thinking` and OpenCode `preferences.variant`. Verify their native values and per-mode support against the pinned versions; they are not a universal reasoning-level abstraction.
- Omitted preferences mean no override; reject `null`. Use explicit native values such as Pi's `thinking: "off"` where supported.
- No arbitrary settings passthrough, `extraArgs`, named presets, or cross-agent defaults in v1. Native CLI passthrough remains separate.

### Resource selection

Keep resource selection under `resources`, separate from model preferences but in the same file. Use plain arrays, **not** an `allow` wrapper:

- Pi: `extensions` and `skills`.
- OpenCode: `plugins` and `skills`, subject to verified native support.

Each array is an exhaustive selection, not additions to discovered defaults:

| Property | Meaning |
| --- | --- |
| Omitted | Preserve that agent/mode's existing default behavior. |
| `[]` | Disable that optional resource category. |
| Nonempty array | Load only the named resources in that category. |

Apply these rules per category even when the `resources` object is present. Document missing versus empty prominently: Pi currently loads approved interactive host extensions by default, so omission does not necessarily mean nothing loads. Built-in provider/auth integrations are not optional user plugins and must not be disabled as a side effect.

Entries are intended to name trusted local resources, for example `pi-files/auto-model`; that spelling is illustrative until resolution is specified. Allowlisting does not install, fetch, or automatically trust packages. Define the local source catalog, identifier uniqueness, missing-resource errors, exact read-only mounts, and native discovery suppression before implementing loading. No arbitrary resource paths or executable host configuration are implied by these identifiers.

Resource loading is a separate checkpoint from model preferences. Each category requires its own discovery, mount, no-write-back, and compatibility tests. An unsupported agent/category/mode must fail explicitly, not be silently ignored. Until a category is implemented, reject its presence, including empty lists, rather than claiming to enforce a selection. Promote the complete design example to a supported user example only when its fields work.

Headless resources require explicit trusted-caller selection and approved source resolution; they cannot inherit interactive host resource discovery or `dev` selections. Do not conflate optional skills/extensions with the agent's mandatory startup protections.

### Configuration loading

For CLI `dev`, automatically load `$XDG_CONFIG_HOME/pi-pod/config.json`, falling back to `~/.config/pi-pod/config.json` when `XDG_CONFIG_HOME` is unset or empty. `XDG_CONFIG_HOME` is Linux's standard user-configuration base directory, normally `~/.config`. Require an absolute configured base; do not resolve it against an untrusted workspace.

| Invocation | Loading behavior |
| --- | --- |
| `dev` | Read the conventional user configuration if it exists. |
| `dev --no-config` | Skip this pi-pod configuration layer. |
| `dev --config PATH` | Use only that explicit file, replacing rather than merging the automatic file. |
| `run` | Do not discover or read personal configuration. |
| `run --config PATH` | Load that explicit file and select only the chosen agent's `run` section. |
| Library API | Receive typed preferences/resources; never implicitly load files. |

`--config` and `--no-config` are mutually exclusive. A missing automatic file is allowed; an invalid or unreadable existing file fails clearly. A missing explicit file is an error. Validate the file before auth, workspace, or Podman side effects, including CLI delegation. No cwd/ancestor search, `.env` loading, shell interpolation, or dynamic imports.

`--no-config` disables this configuration layer only; it does not change auth defaults or independently disable existing approved Pi host preference/resource behavior. Use explicit resource arrays to control categories once supported. No automatic creation or modification of the user's config file.

### Precedence and validation

Define and test one precedence order for each supported preference:

```text
built-in preference default
  < currently approved host preference subset (interactive Pi only)
  < explicit file's selected agent/mode section
  < explicit invocation preference
```

The host subset is current behavior, not permission to discover OpenCode settings. First separate Pi model preferences from extension discovery; preserve existing behavior until a deliberate change is documented.

Keep `-- <agent arguments>` available. For settings managed by the new schema, define how explicit native flags override preferences and emit each managed setting once. Do not rely on undocumented duplicate-flag ordering. Unsupported combinations should be diagnosed before launch, without turning pi-pod into a complete parser for every agent CLI.

Safety settings are not part of that precedence chain: reject preference fields or managed overrides that try to replace mandatory containment/discovery policy. Existing arbitrary agent passthrough remains a separately documented compatibility surface; do not claim to have secured every native flag merely by validating preference files.

Reject unknown schema versions, agents, sections, keys, wrong types, oversized files, symlinked input files, and unsupported features before workspace/auth/container side effects. Validate the full document structurally, but resolve resources and apply settings only from the selected agent/mode; unselected sections must not trigger host reads, mounts, or installs. Never echo raw file contents in errors. Error messages identify a field and allowed form, not its potentially secret supplied value.

### Explicit exclusions

Preference files cannot contain:

- Credential values, automatic credential-variable forwarding, or arbitrary host auth paths.
- Broad native configuration copies, shell commands, executable hooks, host-side plugins, or custom command templates.
- Podman arguments, sockets, added host mounts, privileged mode, or disabled hardening.
- Implicit analysis capture/upload settings from Plan 03.

Auth profile choice, explicit environment-name forwarding, and resource policy remain their existing CLI/library options in this first feature. A preferences file is not an auth profile. Keep `dev` convenient through built-in host-auth support, not a complex mandatory config file.

## 5. Adding more agents without a framework

Consider Codex CLI or Claude Code as candidates, not promised support. Choose the next agent based on an actual daily-use requirement and a compatibility spike, not by adding an unchecked list of executables.

An integration checklist should require:

1. Pin a concrete version and verify installation architecture, licensing/distribution, runtime dependencies, executable path, and update behavior.
2. Document native interactive/headless commands, stdin/prompt handling, unattended permission behavior, cancellation, and exit semantics.
3. Prove startup under the existing rootless/read-only/capability/resource policy. If it needs broader privileges, do not relax the shared baseline to claim support.
4. Specify native container state locations and the supported credential shapes/provider IDs. Distinguish API-token support, profile support, host-auth support, and unsupported login methods.
5. Keep headless use token-capable without requiring personal host configuration. Host-auth support is optional and requires its own selected-provider validation and no-copy-back tests.
6. Audit native project config/plugin discovery. Document differences rather than pretending every agent has Pi's controls.
7. Add shared contract tests plus agent-specific compatibility tests and docs. Unsupported capabilities must produce early, clear errors.

Keep the current shared image initially. Reconsider per-agent images/build targets only when the third integration demonstrates a material size, dependency, or update-cadence problem. If adopted, define an explicit agent-to-image mapping and stable override semantics; no automatic pulls/builds, runtime installers, or new unreviewed image discovery.

Keep executable version pins in an auditable build source. Centralize duplicated runtime image defaults separately and add consistency checks against help/docs/build metadata. Do not generate a complicated image matrix merely to remove a few constants.

## 6. Make run policy and cleanup readable

- Resolve defaults and validate agent, mode, workspace choice, auth source, environment names, limits, and preferences once. CLI and library use the same resolver; Crust remains responsible for CLI syntax.
- Use internal discriminated unions for credentials (`none`, `host`, `profile`) and workspaces (`bind`, `clone`) so required profile names/run IDs cannot be missing. Preserve public compatibility or document an explicit type migration.
- Move `login` out of `run.ts`; retain the shared container lifecycle, not another signal/cleanup implementation.
- Keep the main flow visible: validate → prepare → stage → execute → verify removal → finalize → return.
- If extracting finalization, pass a small explicit resource record and return final outcomes. Avoid a general disposal stack, generic hook engine, or a mutable service object that conceals which resource is still mounted.
- Keep the exact-container removal barrier visible before credential reconciliation, stage deletion, or lock/reservation release. Explain why each failure retains state.
- Do not change setup exceptions into a new public result format as an incidental refactor. Document the current distinction between setup failure and completed execution outcomes.

Write a lifecycle table for success, nonzero exit, abort, timeout, setup failure, failed container removal, and failed reconciliation. Include ownership of workspace, auth stage, prompt stage, dev-resource stage, lock, and reservation.

Investigate host-stage recovery concurrency separately before generalizing it: the current scan refuses stages whose containers are present, and startup has a period before the container exists. Add fixtures for live, preparing, and orphaned runs; do not solve this by silently deleting active stages or weakening existence checks. Any behavior fix is a separate tested checkpoint, not a file move.

## 7. Documentation people can navigate

Keep README as a concise entry point with links, not an exhaustive internals manual. Proposed documentation:

| Document | Contents |
| --- | --- |
| `README.md` | Build/install, Pi/OpenCode dev commands, explicit-token headless recipe, core warnings, links. |
| `docs/usage.md` | Full CLI examples, `--` passthrough, direct versus clone workspace, limits, native host versus container commands. |
| `docs/agents.md` | Per-agent support matrix: pinned version, modes, native provider IDs, auth sources, discovery controls, known limitations. |
| `docs/authentication.md` | Host versus profile versus token lifecycle, refresh tradeoffs, failure/recovery table, optional provider-login workflows. |
| `docs/configuration.md` | Current supported configuration and, after implementation, schema/precedence/examples. No proposed syntax presented as working. |
| `docs/architecture.md` | Source map, dependency direction, trust boundary, lifecycle/state ownership tables, suggested reading order. |
| `docs/development.md` | Pinned Bun commands, container-first worker workflow, tests, adding an agent, upgrading image versions. |
| `docs/security.md` | Maintained guarantees/limitations and links to historical decisions and regressions. |
| `docs/library.md` | Trusted-caller examples, sinks/cancellation, default resolution, cleanup outcomes, setup exceptions. |

Document the distinction between image-pinned and host-installed agent versions. Provide a portable install/link workflow using the trusted launcher, without hardcoded usernames or automatic host configuration changes.

Organize troubleshooting by failure category: prerequisites, image compatibility, configuration validation, authentication, workspace preparation, execution, and cleanup. Give actionable diagnostics and narrowly scoped recovery procedures rather than broad state-reset advice.

Keep `AGENTS.md` aligned with implemented policy and link it to maintained developer/security docs. Mark stale statements in historical plans/reviews as superseded with links; preserve the evidence rather than rewriting history.

Maintain examples with tests or small consistency checks where useful: CLI help/agent choices, default image, exported API examples, configuration examples, and credential-free package installation from a hostile cwd. If README links to new docs, include those docs in the package allowlist or use durable public links; test packed contents. Preserve `private: true` and Apache-2.0 with Commons Clause terminology.

## 8. Implementation checkpoints and acceptance gates

### A — Baseline and documentation map

- Record a tested baseline before structural changes.
- Inventory existing exports, defaults, schemas, and source responsibilities.
- Write architecture/agent/auth matrices and correct README onboarding order.
- Label completed versus deferred work in Plans 01–03 without deleting history.

**Gate:** readers can find the development, automation, and recovery paths, their defaults, and their limitations. Current behavior and proposed configuration are clearly separated.

### B — Behavior-preserving module cleanup

- Centralize defaults; extract container preflight/environment and Pi-specific dev resources.
- Introduce explicit credential/workspace internal types and one default resolver.
- Separate login and, only where helpful, resource finalization.
- Split tests by behavior; extract minimal fake-Podman/temporary-state helpers without hiding safety assertions.

**Gate:** existing regressions pass; public exports, on-disk formats, CLI syntax, mount/environment policy, and default resolution remain compatible. No filesystem reads at module import time.

### C — Agent registry and onboarding contract

- Move Pi/OpenCode command/codec differences into static per-agent modules.
- Add explicit capability validation and registry-driven CLI choices.
- Add a contributor checklist and per-agent tests. Exercise adding a fixture definition in unit tests, not an unreviewed real third agent.

**Gate:** adding an agent no longer requires new `agent === "pi" ? ... : ...` branches in shared lifecycle/staging code; unsupported agents fail early. No plugin loader or arbitrary executable configuration is introduced.

### D1 — Model preferences and configuration loading

- Implement the agreed common model envelope and agent-specific preferences after verifying pinned native flags, values, and precedence.
- Implement bounded user-config auto-loading for CLI `dev`, explicit `--config`, and `--no-config` semantics from section 4. Keep headless and library loading explicit.
- Add non-secret supported examples that omit not-yet-implemented resource fields; retain the complete design example as clearly labeled design documentation.
- Test missing/invalid config, replacement versus merging, mode isolation, and hostile cwd before auth/workspace/Podman effects, including delegation.

**Gate:** unconfigured development stays one command; user configuration is optional. Headless execution never reads personal settings implicitly; no `dev` preferences leak into `run`. All fields have documented provenance and precedence.

### D2 — Resource selections

- Specify trusted local resource catalog and identifier resolution before implementing any loader. Seek review for this remaining design decision.
- Implement plain exhaustive arrays per supported agent/category/mode, with omitted/default, empty/disabled, and nonempty/only-selected semantics.
- Verify native discovery suppression, read-only resource mounts, mandatory bundled auth integration preservation, and explicit-only autonomous sources.
- Update supported examples and capability documentation as each category becomes available.

**Gate:** no implicit installation or broad host-state imports; unknown or unsupported resources fail before launch. Tests prove exact selection and distinguish omitted from empty arrays.

### E — Third-agent spike, then separate implementation decision

- Select one requested agent and complete the compatibility checklist.
- Record supported/unsupported capabilities and image cost.
- Decide whether a shared image remains appropriate before shipping support.

**Gate:** a new agent meets the existing boundary, rather than the boundary expanding to accommodate it. Real-account smoke testing is user-assisted and separate from automated tests.

## 9. Validation strategy

For each implementation checkpoint, use the repository-pinned runtime:

```sh
mise exec -- bun test
mise exec -- bun run typecheck
git diff --check
```

In a pi-pod development worker without Mise, first verify the container's Bun matches the repository pin, then use that runtime directly and report the substitution.

Run opt-in Podman/systemd tests only in a suitable host environment; preserve their documented commands. Do not make OAuth, paid model requests, host credentials, or personal files normal test dependencies.

Add coverage for:

- Every agent × supported mode × auth source, including default headless behavior with unreadable host credential/settings fixtures and explicit `--auth none` token use.
- Selected-provider filtering, missing/malformed host data, XDG/fallback paths, no-copy-back, private stages, active-container recovery refusal, and no credential-bearing argv/diagnostics.
- Native prompt bytes/newlines, leading-dash prompts, agent passthrough, environment names, fixed hardening switches, and version-compatible credential writers.
- CLI/library default parity and agent-specific unsupported capabilities.
- Config precedence, dev-only auto-loading, XDG/fallback paths, explicit replacement, `--no-config`, mutually exclusive flags, mode isolation, unknown keys/versions, symlinks, oversize files, and zero side effects on rejected input.
- Resource omission versus empty versus nonempty arrays, exact selections, missing/ambiguous identifiers, unsupported categories, disabled native discovery, and no installation or host resource reads for unselected modes.
- Auth/prompt/resource retention and clone ownership across every lifecycle outcome.
- Package exports, docs/examples availability, secure launcher from a hostile cwd, and no surprise install/build behavior.

## Completion criteria

- A maintainer can trace one run and explain cleanup ownership from a small source map and lifecycle table.
- Agent-native behavior has a named home; the shared sandbox remains explicit and agent-independent.
- Development and automation defaults are documented consistently across CLI, library, and agent-specific references; structural changes preserve their separation.
- Per-agent preferences, credentials, and execution policy are separate concepts in both code and docs.
- A third agent has a concrete, testable onboarding path, not permission to add host mounts or runtime plugins.
- Examples match shipped behavior; unresolved security limits and deferred features remain visible.
- No automatic host configuration changes, new orchestrator behavior, analysis collection, commits, pushes, or publication occur as part of this plan.
