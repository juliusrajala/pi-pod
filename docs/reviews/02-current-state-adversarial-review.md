# Adversarial review: current state

Status: active review. This document records findings against the checkout as reviewed on 2026-09-17. The earlier [01 review](01-adversarial-review.md) is historical evidence; findings below are current-state observations and are not marked resolved by that document.

## Scope and baseline

Reviewed the maintained documentation, package/bootstrap paths, CLI routing, execution lifecycle, container arguments/lifecycle, authentication staging, workspace/Git preparation, resource monitors, agent adapters, and release recipe. No credentials or real provider accounts were used.

Checks run:

- `bun --version`: 1.3.14.
- `bun test`: 86 passed, 4 opt-in integration tests skipped.
- `bun run typecheck`: passed.
- `bun run format:check`: passed.
- `git diff --check`: passed.
- The repository-pinned commands using `mise exec` could not be run because `mise` is not installed in this environment; the equivalent pinned Bun was available directly.

The review did not modify source code. Findings are listed one by one below.

## Finding 1 — High: the source launcher still executes caller-PATH programs before the trust boundary

**Locations:** `scripts/dev-launcher`, especially `bun --version`, `awk`, `readlink`, `dirname`, and `pwd`.

The launcher is documented as safe to invoke from an untrusted workspace, but it resolves Bun and its shell utilities through the caller's `PATH`. A workspace-controlled PATH entry can therefore replace the executable that is supposed to establish the trusted runtime. The launcher invokes Bun twice, so checking its reported version does not establish that the second invocation is the same executable.

Confirmed with a disposable fixture: a fake `bun` placed first in `PATH` wrote a marker, reported `1.3.14` for the version check, and delegated to the real Bun. Running `./scripts/dev-launcher --help` printed normal help, but the marker was present. The fixture required no Bun preload, Podman, credentials, or source changes.

This also applies to the external `awk`, `readlink`, `dirname`, and `pwd` lookups before TypeScript starts. A target workspace or a caller's workspace-local toolchain can execute host code before `--no-env-file`, `--cwd`, or `restoreCallerEnvironment` take effect. This contradicts the README and `src/cli/bootstrap.ts` comments that describe the launcher as the trusted startup boundary.

**Impact:** host code execution and arbitrary environment manipulation before pi-pod can validate a command or establish containment. This is especially relevant for the documented source-checkout workflow from an untrusted project.

**Required direction:** establish an absolute trusted Bun executable before any caller-controlled PATH lookup, or require a separately trusted runtime path. Avoid resolving bootstrap utilities from the target PATH (use shell builtins or absolute trusted utilities), and add a regression with a hostile PATH containing fake Bun and utility binaries. The release executable has a different bootstrap path, but that does not repair the documented source launcher.

## Finding 2 — High: lifecycle cleanup trusts an unverified container name instead of proving container ownership

**Locations:** `src/container/lifecycle.ts` (`managedContainerExists`, `removeLeftoverContainer`, `stopAndRemove`), `src/execution/run.ts`, and `src/auth/lock.ts`/`src/auth/staging.ts`.

Every run does set `io.pi-pod.managed=true` and, for clones, a run-id label in `src/container/args.ts`. However, lifecycle cleanup and auth recovery never inspect those labels. They use only `podman container exists <generated-name>`, then stop/kill/remove whatever container currently has that name.

An attacker or unrelated same-UID process that wins the name race can cause the attached `podman run` to fail, after which pi-pod's normal leftover cleanup will remove the attacker's container. The same race can occur after a legitimate run exits but before the cleanup query. A stale-name collision also changes the meaning of the authentication safety check: recovery can either be blocked by an unrelated container or, if the original container is in a different Podman context, proceed without proof that the original mount is gone.

The random 12-character name suffix reduces accidental collisions but is not an ownership proof. Names are observable to the same user through process/container inspection, and the wrapper already emits labels that could be checked.

**Impact:** destructive cleanup of an unrelated same-user container, and unsafe credential-stage recovery when name existence does not identify the original managed container.

**Required direction:** inspect and validate the exact managed label set (including a per-operation ownership nonce, not only the user-visible run id) before stop/remove or recovery. Treat a missing/mismatched label, Podman-context mismatch, or inspect failure as an unverified cleanup and retain credentials/stages. Add a fake-Podman regression in which a colliding container has the generated name but lacks the pi-pod labels; assert it is not removed and credentials are not reconciled.

## Finding 3 — Medium: clone preflight buffers unbounded repository output before the workspace budget is enforced

**Locations:** `src/utils/process.ts:commandOutput`, `src/workspace/git.ts`, and the ordering in `src/execution/run.ts`.

`commandOutput` reads all stdout and stderr into memory using `Response(...).text()`. Clone preparation invokes it for `git ls-files --stage` and `git status --porcelain=v1 --untracked-files=all` while the source repository is untrusted. The attribute walk also has a cap on the number of `.gitattributes` files, but no cap on total directory entries traversed.

The configured workspace byte limit is checked only after `prepareWorkspace` returns. Thus an overlarge or adversarial repository can make host-side Git emit a very large index/untracked-file listing, consuming controller memory or CPU before the configured limit can reject it. This is a host denial-of-service path, not an agent-container resource event.

**Impact:** a caller can cause excessive host memory consumption or a long-running preflight using repository contents, despite the documented workspace budget. The failure occurs before a container exists and is not covered by the container limits.

**Required direction:** use bounded/streaming Git inspection with explicit output limits and fail closed when output exceeds them. Bound total attribute-walk work as well as attribute-file size/count, and measure/reject source trees before expensive inspection where possible. Add a fixture that exceeds the inspection-output budget and proves no clone or container is launched.

## Finding 4 — Medium: relative HOME/XDG data settings can redirect host credential reads into the caller workspace

**Locations:** `src/auth/host.ts` (`hostHomeDirectory`, `hostOpenCodeDataDirectory`) and `src/utils/fs.ts:stateDirectory`.

The host configuration readers accept relative `HOME` and relative `XDG_DATA_HOME` values. Unlike `src/config/load.ts`, they do not require absolute paths. The launcher restores the caller's current directory before command processing. Consequently, an interactive invocation from a workspace with `XDG_DATA_HOME=.` reads `./opencode/auth.json`; a relative `HOME` similarly makes Pi's `./.pi/agent/auth.json` relative to the caller directory. These files are then treated as selected host credentials and staged into the container.

This is a configuration/environment boundary issue: the path is not a fixed host home/data location, and a workspace can become the source of what the command describes as host authentication. The same relative-state behavior also makes the wrapper state location cwd-dependent, although workspace/state overlap checks cover many ordinary cases.

**Impact:** credential source confusion and accidental staging of workspace-controlled data; with a deliberately or accidentally relative path, host authentication can read a different file than the operator expects. It also makes security reasoning and recovery paths dependent on the caller's cwd.

**Required direction:** require absolute `HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` values when they are used for host or wrapper state. Reject paths that resolve inside the selected workspace for host credential reads, and add tests for relative/malformed XDG values before any host credential read or state creation.

## Finding 5 — Medium: interactive Pi settings can authorize arbitrary read-only host paths as extension packages

**Locations:** `src/agents/pi/dev-resources.ts` (`parseDevSettings`, `stageHostPiExtensionPackages`).

A local package source from host Pi `settings.json` is resolved with `resolve(baseDirectory, source)`, but it is not constrained beneath the Pi agent directory, a declared package root, or another allowlisted host resource root. Absolute paths and relative traversals are accepted. After `stat`, the resulting path is mounted read-only into the interactive container.

This is narrower than a general host-home mount and may be intentional for a trusted developer's extensions, but it is not an approval mechanism: a settings entry such as `../../sensitive-directory` or `/some/other/host/tree` becomes a host disclosure mount. The agent and any loaded extension code can read the complete selected file/directory. The current tests cover rejecting remote package origins, not arbitrary local path scope.

**Impact:** a compromised/malicious Pi settings file, or an extension package that changes its declared source, can expose unrelated host files to the agent. This weakens the documented invariant that only approved Pi development resources are mounted.

**Required direction:** define and enforce the intended resource root policy (for example, direct extensions plus package roots under a dedicated Pi resource directory). Reject absolute paths and traversal outside those roots, reject symlink escapes using canonical containment checks, and test a package path outside the permitted roots. If arbitrary local paths are intentionally supported, document that as an explicit host-disclosure capability rather than calling the resource set narrowly approved.

## Finding 6 — Medium: agent image contents are version-pinned but not content-pinned or reproducible

**Locations:** `container/Containerfile` and the image/version claims in `README.md` and `docs/agents.md`.

The base Node image is digest-pinned and the Bun archive has a checksum, but Pi and OpenCode are installed with `npm install --global` using only package versions. Their tarballs and dependency trees are not verified by an integrity hash or a checked-in lockfile. OpenCode is also installed without `--ignore-scripts`, so package installation scripts run as root inside the image build.

A mutable or compromised registry response at the requested version can therefore change the agent image while the Containerfile and its audited digest remain unchanged. The resulting image is the code that receives workspace contents and credentials. Rootless Podman limits the build environment's host privileges, but it does not make the agent image trustworthy or reproducible.

**Impact:** supply-chain compromise or registry drift can silently replace the pinned agent/runtime contents; an install script can add arbitrary code to the image during build.

**Required direction:** record and verify package tarball/dependency integrity (or use a reproducible lock/install strategy with verified artifacts), decide whether lifecycle scripts are required, and test that the built image's installed versions and hashes match the audited recipe. Distinguish a version-pinned recipe from a content-pinned release in the documentation.

## Finding 7 — Low: installed-package command name does not match the documented command

**Locations:** `package.json` (`bin`), `README.md`, and `docs/development.md`.

The package declares only `pi-pod-dev` as its executable, while the README says that a linked/installed package should be invoked as `pi-pod`. The release bundle supplies `pi-pod`, but a local tarball or linked package does not provide that name. This is not a containment bypass, but it makes the supported installation path ambiguous and can lead users to bypass the launcher by invoking source files directly.

**Required direction:** either expose the documented `pi-pod` binary (while retaining a clearly named development alias if needed) or change all installation documentation to `pi-pod-dev`; add a packed-install smoke assertion for the documented command.

## Review disposition and next gates

The first two findings should be treated as boundary/lifecycle blockers before calling the source launcher or cleanup path hardened. Findings 3–6 need explicit policy decisions and focused regression tests; they should not be silently downgraded because the normal unit suite passes. Finding 7 is documentation/package hygiene.

Recommended next sequence:

1. Repair and regression-test trusted source bootstrap, including hostile PATH utilities.
2. Add label/ownership verification to every container existence, stop, remove, and recovery decision.
3. Bound host Git inspection and validate absolute host/state paths.
4. Decide the allowed host extension-resource roots and enforce them.
5. Make image package contents content-verifiable before describing the image as pinned/audited.
6. Re-run opt-in Podman and user-assisted authentication checks after the boundary changes.

## Remediation checkpoint

Implemented in the current checkout, with focused regression coverage:

1. The source launcher now selects Bun and bootstrap utilities without caller-PATH discovery; explicit absolute trusted paths are required for nonstandard Bun/tool locations.
2. Container lifecycle, auth-stage recovery, profile locks, and retained-run reservations carry a per-launch ownership nonce and verify managed/owner labels before cleanup or reconciliation. Mismatches retain state and never remove the container.
3. Host command output is bounded, and Git attribute traversal has a total-entry cap.
4. Relative HOME, XDG data, and XDG state paths are rejected.
5. Pi package mounts are canonicalized and restricted to `~/.pi/agent/extensions` and `~/.pi/agent/packages`.
6. The image uses a checked-in Bun lockfile with integrity records, disabled install scripts, and release checksum coverage for the dependency files.
7. The package now exposes the documented `pi-pod` binary alongside `pi-pod-dev`.

Post-change automated result: `bun test` 91 passed and 4 opt-in tests skipped; typecheck, formatting, and `git diff --check` passed. A real image build and Podman integration remain environment-dependent validation gates.
