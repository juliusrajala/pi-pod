# Compiled CLI and platform distribution

**Status: planned.** This is a release/bootstrap hardening project, not a replacement for the container image or a change to pi-pod’s containment policy.

## Goal

Offer two supported ways to run pi-pod:

1. **Source checkout:** retain the existing portable `bin/pi-pod` launcher for contributors and local Bun/package users.
2. **Platform release bundle:** provide a compiled host CLI for a specific supported Linux architecture, so ordinary users can run pi-pod without first installing Bun.

The compiled executable is the **host controller**, not the Pi/OpenCode runtime. It still uses rootless local Podman and the pinned agent image. It must not be presented as a standalone agent runtime, as support for macOS/Windows, or as a replacement for the Containerfile/image build process.

This plan follows a stable, reviewed Plan 05 layout. Do not combine binary compilation with active domain moves, agent/configuration changes, or a container-image upgrade.

## 1. Security and behavior contract

The current shell launcher exists because Bun can load caller-controlled runtime configuration before TypeScript executes. A compiled executable reduces that startup surface only if its runtime autoload behavior is explicitly disabled.

The pinned Bun build currently exposes compile-time autoload controls. Every release build must set at least:

```sh
--no-compile-autoload-dotenv
--no-compile-autoload-bunfig
--no-compile-autoload-tsconfig
--no-compile-autoload-package-json
```

Do not rely on defaults, even if some are currently disabled. Pin the Bun release used to compile the artifact and record all security-relevant build flags in one reviewed script.

The release executable must preserve these properties:

- Launching it from a hostile workspace does not load that workspace’s `bunfig.toml`, `.env`, `tsconfig.json`, or `package.json` before pi-pod validation.
- It keeps the caller’s real cwd and HOME/XDG environment. `pi-pod dev .` resolves `.` to the caller workspace, and approved host-state paths still resolve normally.
- It carries a trusted self-reexecution path so delegated user scopes re-exec the same compiled executable rather than relying on `PATH` or a source launcher.
- It retains the same CLI grammar, public library API, default image, resource limits, auth policy, Podman argv, diagnostics, and lifecycle behavior as the source launcher.
- It never embeds credentials, host configuration, shell aliases, image layers, user state, `node_modules`, or a caller workspace.

A compiled executable is not a substitute for the existing rootless Podman boundary. Repository code remains untrusted inside a bind mount; network and credential limits remain unchanged.

## 2. Entrypoints

### Source checkout entrypoint

Keep:

```text
bin/pi-pod
```

as the supported source/package launcher. It verifies Bun, starts Bun from the trusted package root with automatic `.env` loading disabled, temporarily isolates startup HOME, records the caller context, and then invokes `src/cli.ts`.

Do not overwrite `bin/pi-pod` with a generated architecture-specific executable. Keeping a binary there would produce platform-specific source-tree diffs, make one checkout unusable on another architecture, and require Bun before a fresh checkout could rebuild it.

### Compiled entrypoint

Add a dedicated compiled entry module, for example:

```text
src/cli/compiled.ts
```

It must call the same CLI application but must **not** invoke source-launcher-only `restoreCallerEnvironment()` semantics. The current restore helper expects launcher handoff variables; calling it in a compiled binary without those variables can change HOME incorrectly.

The compiled entry must establish the trusted delegated-scope re-execution path from the executable itself. Verify the pinned Bun compiled-runtime API for the executable path (for example, `process.execPath`) and test it. Refactor delegation to receive an explicit trusted executable path if that is clearer; do not make it discover a launcher through untrusted PATH or cwd.

Keep the source and compiled entrypoints thin. They may differ only in safe bootstrap/re-exec setup; all command routing remains in `src/cli/app.ts` and domain operations remain shared.

## 3. Release artifacts and build recipe

### Initial supported target

Produce one tested release bundle for the current supported platform:

```text
linux-x64
```

Use the pinned Bun cross-compilation target corresponding to Linux x64 (currently expected to be `bun-linux-x64`), but verify exact target spelling against the pinned Bun version before committing build scripts. Do not claim other targets merely because Bun can cross-compile.

A Linux arm64 bundle is a separate follow-up. It requires:

- a multi-architecture or arm64-compatible pinned agent image;
- Containerfile Bun download/checksum and base-image validation for arm64;
- real rootless Podman/cgroup smoke validation; and
- a distinct build artifact and checksum.

Do not produce macOS or Windows artifacts while pi-pod itself requires native Linux and local rootless Podman.

### Bundle, not an ambiguous lone binary

A binary-only `dev`, `run`, or `login` invocation can use a prebuilt local image. `pi-pod build`, however, needs the audited Containerfile and its build context. Initial releases should therefore be a small platform bundle:

```text
pi-pod-linux-x64/
  pi-pod                         compiled executable
  container/Containerfile         exact audited build recipe
  SHA256SUMS                      hashes for bundle contents
  README.md                       short platform/run requirements
```

The compiled executable resolves `container/Containerfile` relative to its own canonical executable location, never relative to cwd. Require the sibling file to be a regular non-symlink file and fail with an actionable error if it is missing or altered. The bundle’s Containerfile context is intentionally only its `container/` directory.

Do not silently fall back to a caller-selected Containerfile, download a recipe, use an arbitrary `--file`, or construct a recipe in `/tmp`. Embedding the Containerfile into a single executable is a possible later optimization only after the pinned Bun asset mechanism, update behavior, and equivalent integrity tests are reviewed.

The source launcher continues to resolve the source checkout’s `container/Containerfile` as today. Share only safe path-resolution code where it does not obscure which artifact layout is being used.

## 4. Build and verification commands

Add a trusted release-build script under `scripts/`, for example:

```text
scripts/build-release.ts
```

Its responsibilities:

1. Require the pinned Bun version and run from the canonical repository root.
2. Refuse a dirty/unexpected output path unless an explicit release-clean option is designed and tested; never recursively delete an arbitrary caller path.
3. Invoke Bun compilation with all autoload protections and the selected exact target.
4. Assemble the platform bundle outside the source runtime paths, with private/normal artifact permissions appropriate for distribution.
5. Copy the reviewed Containerfile and a minimal release README.
6. Generate SHA-256 hashes after contents are complete.
7. Run a post-build smoke test against the produced executable before reporting success.

Expose reviewed package scripts, for example:

```sh
mise exec -- bun run build:release -- --target linux-x64
mise exec -- bun run verify:release -- dist/pi-pod-linux-x64
```

Names and output paths may differ, but they must be explicit, target-qualified, and ignored by Git. `dist/` artifacts, temporary compilation outputs, and release checksums generated locally must not enter the package `files` allowlist or normal source tarball.

The script must use Bun directly through the pinned environment. It must not call `npm`, `npx`, a globally installed Bun, a network installer, or a package-manager postinstall hook. It may run `podman build` only through the existing reviewed build path; no automatic image build belongs in binary compilation.

## 5. Required tests

Add credential-free automated coverage for the compiled artifact. Tests may compile once per supported host test target; gate cross-platform artifacts separately rather than pretending they ran locally.

### Bootstrap boundary

From a disposable hostile directory containing:

- a `bunfig.toml` preload that would create a harmless marker;
- a `.env` file with another harmless marker/configuration value;
- optional `tsconfig.json` and `package.json` fixtures;

run the compiled executable with `--help`. Assert:

- no marker was created;
- usage is printed successfully;
- no host workspace code ran;
- caller cwd remains available to application-level path handling.

Retain the corresponding source-launcher hostile-cwd test. The compiled test proves the compile flags, not merely source-launcher behavior.

### Context and delegation

Test that a compiled executable:

- observes the caller cwd for `dev .` using fake Podman;
- resolves normal HOME/XDG locations without source-launcher handoff variables;
- supplies a trusted absolute self path to delegated-scope construction; and
- does not execute an attacker-controlled `pi-pod` found earlier in PATH.

### Bundle integrity and build behavior

- Verify source mode finds the source Containerfile and release mode finds only the adjacent bundle Containerfile.
- Reject a missing, symlinked, or non-regular release recipe before Podman is invoked.
- Verify build context remains exactly the reviewed `container/` directory.
- Verify release hash generation covers the executable and Containerfile; a verification command detects alteration.
- Smoke-test `--help`, public CLI parsing, and a fake-Podman `build` invocation from the generated bundle.
- Retain package import/bin smoke tests. The Bun package binary remains the source shell launcher unless a separately reviewed platform-package strategy is adopted.

Run the normal suite, typecheck, formatter check, `git diff --check`, and applicable Podman/systemd integrations. A real compiled release smoke test on Linux x64 is required. Do not use provider login, personal auth files, paid model calls, or a real project workspace.

## 6. Documentation and distribution

Update the root README and `docs/development.md` to distinguish clearly:

| Use case                    | Supported entrypoint                      |
| --------------------------- | ----------------------------------------- |
| Contributor/source checkout | `./bin/pi-pod` with pinned Bun            |
| Linked/local Bun package    | package `pi-pod` binary (source launcher) |
| Linux x64 release bundle    | `./pi-pod-linux-x64/pi-pod`               |

Document that the release bundle still requires Linux, rootless Podman, cgroup v2 limits, and an image build before first agent use. Explain when `pi-pod build` needs the adjacent Containerfile. Include checksum verification, but do not imply signatures or a public release channel until one is actually chosen.

Keep the package private and source-available under Apache-2.0 with Commons Clause. Do not add registry publication, GitHub release automation, update checks, self-modification, auto-download, shell alias installation, or host PATH changes. Distribution may initially be manual release-bundle copying or source checkout use.

Update architecture docs to show both startup paths. Explain why the source wrapper remains even after compiled releases exist, and why compilation flags—not compilation alone—prevent runtime Bun autoloading.

## 7. Implementation checkpoints

### A — Prototype and bootstrap contract

- Verify pinned Bun compile target syntax and compiled runtime self-path behavior.
- Add the compiled entrypoint and explicit bootstrap/re-exec setup.
- Compile a disposable Linux x64 artifact with all autoload disabled.
- Add hostile-workspace, cwd/HOME, and delegation unit tests before changing distribution scripts.

**Gate:** compiled `--help` cannot trigger hostile Bun config/env fixtures and has equivalent caller-context behavior without invoking `restoreCallerEnvironment()`.

### B — Bundle assembly and secure build recipe lookup

- Add trusted target-qualified release build/verify scripts and ignored output layout.
- Teach build-recipe resolution to distinguish source and release bundle locations explicitly.
- Add adjacent-recipe validation, fake-Podman build, hash, and altered-bundle regressions.

**Gate:** source and release modes use only their intended audited Containerfile; no missing/altered recipe reaches Podman.

### C — Documentation and release validation

- Update user/contributor/architecture docs and package boundaries.
- Run reproducible local build/smoke validation from a clean disposable directory.
- Record platform support honestly and leave arm64 as deferred until its image/runtime work is complete.

**Gate:** a user can choose source or release-bundle use without installing the wrong artifact, depending on a hidden Bun runtime, or mistaking the compiled CLI for the agent image.

## Non-goals

No changes to agent behavior, configuration semantics, auth sources, workspace policy, Podman hardening, host mounts, release hosting, registry publication, automatic updates, cryptographic signing service, cross-platform runtime support, or container image contents. Do not remove the source launcher until a separately reviewed source-development alternative preserves its hostile-workspace protection.
