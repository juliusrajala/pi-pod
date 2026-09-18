# Host-platform abstraction and macOS support

**Status: planned. Linux remains the only supported host until the macOS acceptance gates below pass.**

## Goal

Separate host-platform policy from shared execution, authentication, workspace, and Podman lifecycle code. The first implementation checkpoint is a behavior-preserving extraction of the current Linux policy into a small, static `src/platform/` domain. That makes macOS support possible to develop and test without treating a Podman Machine or an arbitrary remote service as equivalent to native Linux.

This plan is intentionally a host-controller change. Pi and OpenCode remain Linux container workloads even when the host is macOS.

## Contract and non-negotiable constraints

- Preserve the existing Linux boundary: rootless local Podman, dropped capabilities, `no-new-privileges`, read-only image root, restricted mounts/environment, resource limits, and verified cleanup before credential or clone-state cleanup.
- Do not add a plugin system, runtime-selected backend, arbitrary Podman arguments, Docker fallback, socket mount, SSH forwarding, proxy forwarding, host networking, or credential values in arguments/diagnostics.
- Do not accept `serviceIsRemote` merely to claim macOS support. A supported macOS Podman Machine must have a separately verified, local-machine contract; arbitrary remote Podman remains unsupported.
- Keep hardening flags visible in `src/container/args.ts`. A platform module may select reviewed capabilities, but must not return an opaque list of arbitrary Podman flags or mounts.
- Preserve the public library surface, including `buildPodmanRunArgs`, until an intentional compatibility decision is documented.
- A Darwin adapter initially fails before workspace, profile/state, credential, or Podman side effects. It is not documented as supported until integration validation passes.
- The active adversarial review's source-bootstrap and exact-container-ownership findings are blockers for this work. Do not use this extraction to bypass or weaken those fixes.

## Current ownership map

| Concern                                                       | Current owner                                                                      | Target owner                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Linux host/rootless/cgroup/remote preflight                   | `src/container/args.ts`                                                            | `src/platform/linux.ts` (or focused Linux children)                       |
| `keep-id`, host UID/GID, SELinux private relabel              | `src/container/args.ts`                                                            | Linux platform policy consumed by visible common argv construction        |
| `systemd-run --user` CPU-controller delegation                | `src/cli/delegation.ts`                                                            | Linux platform delegation policy; CLI remains the re-exec caller          |
| State/config/data fallback paths                              | `src/utils/fs.ts`, `src/config/load.ts`, `src/auth/host.ts`                        | platform path policy, with domain code retaining read/write authorization |
| Pi host-resource root                                         | `src/agents/pi/dev-resources.ts`                                                   | platform home-path helper plus existing Pi-specific resource policy       |
| Trusted source launcher portability                           | `scripts/dev-launcher`                                                             | portable trusted launcher; it must work before TypeScript starts          |
| Common argv, environment policy, lifecycle, workspace cleanup | `src/container/`, `src/workspace/`                                                 | remain domain-owned and host-neutral                                      |
| Agent image and in-container paths                            | `container/Containerfile`, `src/agents/`                                           | remain Linux-container-owned                                              |
| Linux-only release targets                                    | `scripts/build-release.ts`, `scripts/verify-release.ts`, `src/cli/distribution.ts` | remain Linux-only until a separate Darwin release gate passes             |

Relevant regression coverage is in `src/container/args.test.ts`, `src/container/preflight.test.ts`, `src/container/podman.integration.test.ts`, `src/cli/delegation*.test.ts`, `src/execution/run.test.ts`, `src/cli/app.test.ts`, and the host-path tests under `src/config/`, `src/auth/`, and `src/agents/pi/`.

## Target shape

Introduce a fixed internal platform selector and a deliberately narrow platform contract:

```text
src/platform/
  contract.ts       host IDs, paths, and reviewed container/delegation capabilities
  current.ts        maps the runtime host to a built-in implementation only
  linux.ts          current Linux path, Podman, relabel, identity, and delegation policy
  darwin.ts         fail-closed initially; enabled only after the macOS gates
```

The contract must describe named capabilities, not arbitrary command fragments. For example, it may distinguish supported mount-label handling, identity mapping, and delegated-scope availability; `container/args.ts` continues to own the complete audited argument list and only applies the explicitly recognized capability. `container/lifecycle.ts` continues to own process launch and verified cleanup. `platform/` must not import `cli/`, `execution/`, `auth/`, or `workspace/`.

Platform path helpers determine conventional absolute fallback locations only. `auth/`, `state/`, `config/`, and agent resource code remain responsible for validation, bounded reads, private ownership, symlink handling, and which host data is permitted to cross the boundary. Relative `HOME`/XDG values must be rejected before they can select host credentials or wrapper state.

## Implementation checkpoints

### A — Baseline and blocker resolution

1. Start from a green, reviewed checkpoint; do not overwrite unrelated in-progress work. In particular, complete or isolate the current ownership-label changes in `src/container/args.ts` before changing its shape.
2. Resolve and regress the active review's trusted-launcher and exact-container-label findings across lifecycle, auth recovery, retained-run removal, and cleanup.
3. Record Linux characterization tests for preflight, cgroup delegation, UID mapping, relabel behavior, mount/environment restrictions, and path defaults.
4. Ensure an unsupported-host check can run before any workspace, profile/state, host-auth, or Podman side effect for CLI and library operations.

**Gate:** Linux behavior and its security regressions pass; a platform extraction cannot conceal an unresolved ownership or bootstrap failure.

### B — Extract the Linux platform policy

1. Add the static `src/platform/` contract and Linux implementation; do not make the host selectable through CLI flags, environment values, or configuration.
2. Move Linux preflight and delegated-scope decisions out of `container/args.ts` and `cli/delegation.ts`. Keep common Podman flags and lifecycle behavior in their present owners.
3. Route host state/config/data and Pi home-root fallbacks through platform path helpers without changing existing Linux paths or XDG precedence.
4. Replace GNU-only launcher assumptions (`readlink -f` in particular) with a trusted portable shell implementation. It must retain absolute trusted-Bun resolution, hostile-PATH resistance, caller-cwd restoration, and disabled Bun auto-loading.
5. Add direct Linux platform tests and preserve existing end-to-end fake-Podman assertions.

**Gate:** on Linux, the generated argv, Podman-client environment, path resolution, delegation behavior, error categories, and cleanup ordering are unchanged except for intentional blocker fixes.

### C — Define the macOS Podman Machine contract

Before enabling Darwin, perform a disposable, credential-free compatibility investigation on supported Intel and Apple Silicon hosts. Record the exact Podman and machine versions/configuration tested and decide all of the following:

1. How pi-pod proves it is talking to a local Podman Machine rather than an arbitrary remote service or caller-selected endpoint.
2. Whether bind mounts preserve canonical-path, read-only/read-write, symlink, and caller-owned-workspace semantics across the macOS-to-VM boundary.
3. Whether the chosen identity mapping preserves host ownership for direct workspaces and native credential writers; do not assume Linux `--userns=keep-id` semantics transfer unchanged.
4. Which CPU, memory, PID, temporary-storage, and workspace-monitor guarantees are enforceable in the guest versus observable on the host. Do not claim host cgroup-v2 enforcement when limits only apply inside the VM.
5. Which approved networking mode preserves no published ports, no host networking, and no proxy forwarding.
6. Whether SELinux relabeling is unavailable. If so, reject `--relabel-workspace` on macOS rather than silently making it a no-op, and define the safe handling for wrapper-owned staging and clones.
7. The native macOS locations and schemas for Pi and OpenCode credentials/settings, plus pi-pod's conventional JSON configuration and private state directories. XDG variables may be honored only when absolute; defaults require an explicit, documented macOS decision.
8. Container inspection, labels, cancellation, timeout, and delayed-container cleanup behavior through the machine connection.
9. Workspace dependency behavior: macOS-built `node_modules` and generated binaries cannot be assumed compatible with the Linux guest; clone workspaces must install guest-compatible dependencies, and host package caches, configuration, and private-registry credentials remain unmounted. Decide compatible-image/toolchain, network, and storage-budget behavior explicitly.

**Gate:** each item has a written, tested decision. If any containment or ownership property cannot be established, Darwin remains unsupported rather than falling back to a weaker mode.

### D — Implement and test Darwin support

1. Replace the fail-closed Darwin implementation with only the capabilities validated in checkpoint C. Continue rejecting arbitrary remote services.
2. Add platform-unit tests using injected platform selection/capabilities rather than mutating global `process.platform`. Prove unsupported paths make no host-state, credential, workspace, or Podman call.
3. Add opt-in macOS integration tests for image build, mount access modes, non-default ownership, guest-compatible workspace dependency installation, private state/auth staging, explicit environment forwarding, no credential-bearing argv, network modes, limits, Ctrl-C/timeout cleanup, exact-label collision refusal, and retained-run removal.
4. Keep Linux integration coverage and systemd delegation Linux-only. Darwin must not attempt `systemd-run`.
5. Add a source-checkout smoke test on macOS from a hostile workspace/PATH; the portable launcher remains a trusted boundary.

**Gate:** both host architectures pass the documented integration matrix without personal credentials, paid provider calls, broad host mounts, or relaxed isolation.

### E — Image architecture, releases, and documentation

1. Treat Linux container image architecture as separate from host support. Validate or add pinned Linux image inputs for every supported Podman-Machine guest architecture, including Bun archive checksum and agent compatibility.
2. Keep release builds Linux x64-only until a separately audited Darwin artifact, bundle recipe, checksum flow, and hostile-cwd smoke test exist. Do not imply that Bun cross-compilation alone validates a host/container combination.
3. Once Darwin is actually supported, update `README.md`, `docs/usage.md`, `docs/development.md`, `docs/security.md`, `docs/architecture.md`, CLI help, and release documentation with exact requirements and limitations. Do not rewrite historical plans/reviews.
4. Update `plans/README.md` as checkpoints complete; archive this plan only after maintained documentation describes the shipped contract.

## Validation

At every implementation checkpoint run:

```sh
mise exec -- bun run format:check
mise exec -- bun test
mise exec -- bun run typecheck
git diff --check
```

Run the Linux integrations only on an appropriate host:

```sh
PI_POD_INTEGRATION=1 mise exec -- bun test src/container/podman.integration.test.ts
PI_POD_SYSTEMD_INTEGRATION=1 mise exec -- bun test src/cli/delegation.integration.test.ts
```

Add an explicit macOS opt-in integration command only with the Darwin implementation and document its required local Podman Machine setup. Tests use disposable fixtures and fake credentials only.

## Completion criteria

- [ ] Linux-specific host policy is isolated behind a small, static platform domain; common lifecycle and hardening remain auditable in their existing domains.
- [ ] Linux behavior, security invariants, public API, and hostile-launcher protections are preserved or deliberately strengthened with regressions.
- [ ] No user-controlled backend/platform selection or arbitrary remote Podman acceptance exists.
- [ ] macOS path, machine, mount, identity, relabel, dependency, network, resource, and cleanup semantics are explicitly decided and tested.
- [ ] Darwin support, if enabled, has real Podman-Machine integration evidence for each advertised host and guest architecture.
- [ ] Documentation and release claims state only the platforms and guarantees actually validated.
