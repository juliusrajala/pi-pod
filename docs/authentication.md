# Authentication

pi-pod supports three distinct sources. They are not interchangeable settings bundles.

| Source                   | `dev`                       | `run`                        | Ownership and lifecycle                                                                                                                                                                     |
| ------------------------ | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                   | Default for Pi and OpenCode | Rejected                     | Reads and stages one selected host credential in a fresh private per-session directory. Concurrent interactive dev sessions are supported; it never mounts or writes host agent state back. |
| Named profile            | Explicit `--auth <profile>` | Default profile is `default` | pi-pod-owned selected-provider credentials under `$XDG_STATE_HOME/pi-pod/auth/` (or `~/.local/state/pi-pod/auth/`). One container uses a profile at a time.                                 |
| `none` plus `--env NAME` | Yes                         | Yes                          | A trusted caller explicitly forwards one allowed API-key variable through the Podman client environment, not argv.                                                                          |

## Profiles and recovery

Create a profile only when a provider needs native subscription login. Named profile sessions are intentionally serialized because the agent may refresh and persist the credential; concurrent interactive host-auth sessions do not share that lock:

```sh
./bin/pi-pod login --agent pi --provider openai-codex --profile worker
./bin/pi-pod auth recover --agent pi --profile worker
./bin/pi-pod auth discard --agent pi --profile worker
./bin/pi-pod auth unlock --agent pi --profile worker
```

Use recovery only when the command reports an interrupted stage and verifies its recorded container is absent. `discard` removes an unwanted retained stage; `unlock` removes only a stale lock whose PID and exact container are gone. Do not delete the auth state tree as a troubleshooting shortcut.

| Outcome                                                            | Workspace                                             | Auth stage/profile lock                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Normal exit or nonzero agent exit after verified container removal | Clone retained; bind untouched                        | Selected profile credential is reconciled; stage is removed and lock released. Host stage is discarded without copy-back. |
| Timeout or abort after verified container removal                  | Clone retained; bind untouched                        | Same reconciliation/discard path applies.                                                                                 |
| Setup failure before launch                                        | Acquired clone preparation is removed; bind untouched | Any acquired lock is released; no completed execution result is returned.                                                 |
| Container removal cannot be verified                               | Clone reservation retained                            | Credential, prompt, and resource stages remain private; profile lock remains retained.                                    |
| Credential reconciliation fails                                    | Clone retained                                        | Private stage is retained for guarded recovery; the result/CLI reports recovery is needed.                                |

## API keys

```sh
./bin/pi-pod run . --auth none --env ANTHROPIC_API_KEY --prompt "Summarize the repository"
```

Names are validated against a narrow allowlist policy. Forge, SSH, database, proxy, cloud-secret, and unrelated credential variables are rejected. Never pass a credential if repository code run by the agent must not receive it.

For the supported credential shapes and host paths, see [agents.md](agents.md). For user-assisted OAuth validation without exposing tokens, see the procedure in the [README](../README.md#required-manual-oauth-validation-for-autonomous-profiles).
