# Security boundary

pi-pod is a small execution boundary, not a sealed vault, daemon, plugin platform, or deployment orchestrator.

## Maintained guarantees

- Rootless Podman with keep-id mapping, dropped capabilities, `no-new-privileges`, read-only image root, default seccomp/SELinux separation, private namespaces, and resource limits.
- One writable project mount plus bounded writable `/tmp` and `/home/agent`; no Podman socket, host networking, published ports, SSH agent, desktop sockets, parent project mount, or arbitrary Podman options.
- Explicit environment-name forwarding only. Credential values do not enter Podman argv or pi-pod diagnostics.
- `run` and trusted headless-library use do not read or mount host Pi/OpenCode credentials, settings, extensions, sessions, skills, analytics, or shell configuration.
- Interactive host auth stages only a selected native credential in a fresh private per-session directory, allowing concurrent dev sessions without shared state. Interactive Pi resource mounts are restricted to canonical paths under `~/.pi/agent/extensions` or `~/.pi/agent/packages` and are read-only; pi-pod never writes host Pi/OpenCode state back.
- Retained clone deletion is guarded by ownership, reservation, and exact-container checks. Caller-owned bind workspaces are never removed automatically.

## Limits

- A bind workspace is writable by the agent and may contain `.env` files, Git configuration, or destructive repository code.
- A supplied credential can be read or exfiltrated by repository code the agent runs.
- `pasta` permits outbound networking; it is not an egress allowlist.
- Workspace and stage monitors can overshoot; they are not quota-backed aggregate disk limits.
- Containers share the host kernel. Same-UID filesystem races are not fully descriptor-anchored recursive operations. Host authentication and wrapper state require absolute HOME/XDG paths.

Historical decisions and adversarial evidence are retained in the public [plans](https://github.com/juliusrajala/pi-pod/tree/main/plans) and [reviews](https://github.com/juliusrajala/pi-pod/tree/main/reviews). They are history, not a substitute for this maintained policy.
