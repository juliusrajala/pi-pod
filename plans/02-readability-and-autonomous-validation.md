# Readability refactor and autonomous validation

## Goal

Make the implementation easier to review without changing its security contract, then validate the credential paths needed by headless/autonomous callers.

This follows the completed dev-mode work:

- Interactive Pi `dev` may stage the selected host Codex credential and trusted extension resources.
- Headless `run` must never read host Pi credentials, host Pi settings, or host extensions.

## Non-goals

- Do not migrate `agent-orchestrator` to this library.
- Do not add commits, copy-back, publishing, PR creation, a daemon, or a credential broker.
- Do not weaken resource limits, workspace ownership, or the host-execution boundary to simplify a refactor.
- Do not make real-account OAuth a normal test-suite dependency.

## Baseline gate

Before every checkpoint and after every small diff:

```bash
bun test
bun run typecheck
PI_POD_INTEGRATION=1 bun test src/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 bun test src/cli/delegation.integration.test.ts
```

Keep the existing fake-Podman, hostile-Bun, hostile-Git, symlink, retained-clone, host-auth, and cgroup-delegation regressions passing. Add a focused regression before moving a safety decision to a new module.

## Part 1 — readability refactor

### 1. Workspace boundaries

Split `src/workspace.ts` by responsibility while retaining its current public behavior:

1. Extract controlled local Git inspection and clean-HEAD clone creation into `src/workspace/git.ts`.
   - Preserve the minimal Git environment and filter-attribute rejection before any host Git command.
   - Preserve no-remotes, no-submodules, no-alternates, no-hooks/shared-object behavior.
2. Extract retained-run metadata, reservation checks, and guarded removal into `src/workspace/runs.ts`.
   - Preserve canonical state-root checks, exact-container verification, quarantine-and-revalidate removal, and the rule that only acquired clone directories are removable.
3. Keep `workspace.ts` as the readable policy entry point: bind versus clone selection, workspace/state overlap rejection, and composition of Git/run helpers.

**Acceptance gate:** workspace tests still cover dirty Git, malicious filters, duplicate IDs, symlinked state, active reservations, dead-wrapper containers, and retained cleanup. No caller-owned bind path becomes removable.

### 2. Utility boundaries

Replace the catch-all `src/utils.ts` incrementally:

1. Move descriptor/no-follow bounded reads, private-directory creation, canonical path checks, and guarded deletion primitives to `src/utils/fs.ts`.
2. Move sanitized host environment and command execution to `src/utils/process.ts`.
3. Keep only small shared error/type/path helpers at `src/utils.ts`, or remove it when no coherent shared surface remains.

Do not change filesystem behavior during the move. In particular, retain the bounded descriptor read, private-ancestor validation, and quarantine-before-recursive-delete behavior.

**Acceptance gate:** filesystem and workspace regression tests pass unchanged; process callers retain their minimal environment rather than inheriting arbitrary caller state.

### 3. Run lifecycle readability

Keep lifecycle process ownership in `src/container/lifecycle.ts`. Reduce `src/run.ts` to an easy-to-scan sequence:

```text
validate → prepare workspace → resolve credential source → stage resources
→ execute → verify cleanup → reconcile/discard → report result
```

Extract only cohesive helpers, for example credential-source/session setup and final result reconciliation. Do not split simple linear policy merely to reduce line count.

**Acceptance gate:** run tests cover pre-abort zero side effects, host-dev source-only staging, headless host-auth rejection, profile reconciliation retention, clone reservation release, output-sink failure, and client-exit leftover removal.

## Part 2 — autonomous-mode validation

### 4. Freeze the autonomous credential contract

Document and test the only accepted sources for `run`:

| Source | Allowed in `run` | Purpose |
| --- | --- | --- |
| `--auth <pi-pod-profile>` | Yes | Wrapper-owned selected-provider profile |
| `--auth none --env NAME` | Yes | Explicit task/API credential chosen by trusted caller |
| Host Pi `auth.json` / host extensions/settings | No | Interactive-dev-only resources |

Before adding any new source, define who creates it, where it lives, what exact files are staged, how refresh/recovery works, and how it is removed. No automatic discovery of orchestrator or personal configuration.

**Acceptance gate:** a headless request for `host` fails before state, workspace, or Podman side effects; headless Podman argv and environment never contain host credential paths or unrelated host environment names.

### Future autonomous extension policy

Autonomous extensions are a planned capability, but are **not** part of this implementation checkpoint.

They must be supplied explicitly by the trusted caller as a reviewed, version-pinned local package or wrapper-owned resource. pi-pod must stage/mount them read-only into the container and generate only the minimal extension settings needed to load them. It must not discover or load the developer’s host extension directory, host Pi settings, packages, analytics state, or credentials.

Before enabling an analytics extension for autonomous work, define and test:

1. its exact package/version or content identity;
2. its read-only code/resource mounts;
3. its separate configuration and any explicitly named credential source;
4. permitted network behavior and what task/session metadata it may emit;
5. failure behavior—analytics failure must not silently broaden access or hide an agent result; and
6. a fake sink/provider regression that proves no personal host Pi state is read.

This design can reuse the filtered read-only extension-package mechanism introduced for dev, but the autonomous caller must name every package. It must never inherit dev defaults.

### 5. Validate API-key and protected-local-profile paths with fakes

Add/retain fixture coverage for:

1. Explicit API-key forwarding reaches the container only when named and never appears in Podman argv or diagnostics.
2. Forge, SSH, database, proxy, and unrelated credential names remain rejected/not forwarded.
3. A wrapper-owned Pi/OpenCode profile stages only its selected credential shape; unknown fields and unrelated providers are rejected.
4. Native agent writes/locks work in the staged directory under keep-id, including the non-1000 mapping integration fixture.
5. Cancellation, timeout, client exit, failed reconciliation, and interrupted-stage recovery preserve credential state until the exact container is verified absent.
6. Autonomous runs cannot load dev-only host extension/settings mounts, even when those resources exist on the machine.

Use fake credentials only. Do not inspect or print personal tokens.

### 6. User-assisted OAuth gate — only if autonomous OAuth profiles are needed

API-token/local-profile autonomous use does not require this gate. If an autonomous Pi or OpenCode subscription profile is intended:

1. Build the image and use a disposable named pi-pod profile.
2. Complete the native provider login with the user present.
3. Run a separate fresh-process headless task using that profile.
4. Later, repeat after provider refresh/expiry timing permits.
5. Record only provider, command exit status, reuse result, and refresh result. Never record a device code, redirect URL, access token, or refresh token.

If the provider’s callback flow is unsuitable for the isolated container, treat that as an explicit unsupported autonomous-profile method until a separately reviewed solution exists; do not expose host networking, desktop sockets, or personal Pi state as a workaround.

## Completion criteria

This phase is complete when:

- Module responsibility is visible from filenames and top-level functions without losing existing safety tests.
- `dev` remains the only mode with host Codex/extensions resources.
- `run` has a tested, documented profile/API-key contract suitable for a future trusted orchestrator caller.
- The real OAuth gate is either completed with user participation for each intended provider or explicitly deferred because autonomous use relies on API/local credentials.
- Remaining limits stay documented: same-UID filesystem races are not fully descriptor-anchored recursive operations; workspace/auth monitors are not quota-backed hard disk limits; setup failures still throw rather than returning a separate setup result.
