# Security boundary

pi-pod is a small execution boundary, not a sealed vault, daemon, plugin platform, or deployment orchestrator.

## Maintained guarantees

- Rootless Podman with keep-id mapping, dropped capabilities, `no-new-privileges`, read-only image root, default seccomp/SELinux separation, private namespaces, and resource limits.
- One writable project mount plus bounded writable `/tmp` and `/home/agent`; no Podman socket, host networking, published ports, proxy forwarding, SSH agent, host home, desktop sockets, parent project mount, or arbitrary Podman options.
- Fixed reviewed agent environment only. Credential values do not enter Podman argv or pi-pod diagnostics.
- Public headless-library use requires an explicit pi-pod API-token profile and does not read or mount host Pi/OpenCode credentials, settings, extensions, sessions, skills, analytics, or shell configuration. The local CLI may intentionally select its agent's reviewed host credential for either `dev` or `run`.
- Host and API-token auth stage only one native credential in a fresh private per-container directory. Stages are source-only: pi-pod never writes host Pi/OpenCode state back or reconciles agent changes to an API-token profile. Interactive Pi package selections copy only explicitly listed files into bounded private snapshots mounted read-only. The source package is not mounted. Without a selection, legacy resource mounts remain restricted to canonical paths under `~/.pi/agent/extensions` or `~/.pi/agent/packages` and are read-only.
- Retained clone deletion is guarded by ownership, reservation, and exact-container checks. Caller-owned bind workspaces are never removed automatically.

## Limits

- A bind workspace is writable by the agent and may contain `.env` files, Git configuration, or destructive repository code.
- A supplied credential can be read or exfiltrated by repository code the agent runs.
- `pasta` permits outbound networking; it is not an egress allowlist.
- Workspace and stage monitors can overshoot; they are not quota-backed aggregate disk limits.
- Containers share the host kernel. Same-UID filesystem races are not fully descriptor-anchored recursive operations. Host authentication and wrapper state require absolute HOME/XDG paths.

Historical decisions and adversarial evidence are retained in the [plans](plans/README.md) and [reviews](reviews/). They are history, not a substitute for this maintained policy.
