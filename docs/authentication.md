# Authentication

Choose how the container agent authenticates to its model provider. Credentials and agent settings are separate: selecting an auth source does not import a host settings bundle.

Examples use the compiled `./pi-pod` executable from its [bundle directory](installation.md#set-up-the-bundle).

## Choose authentication

| Source                   | `dev`                       | `run`                        | Ownership and lifecycle                                                                                                                                                                     |
| ------------------------ | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                   | Default for Pi and OpenCode | Rejected                     | Reads and stages one selected host credential in a fresh private per-session directory. Concurrent interactive dev sessions are supported; it never mounts or writes host agent state back. |
| Named profile            | Explicit `--auth <profile>` | Default profile is `default` | pi-pod-owned selected-provider credentials under `$XDG_STATE_HOME/pi-pod/auth/` (or `~/.local/state/pi-pod/auth/`). One container uses a profile at a time.                                 |
| `none` plus `--env NAME` | Yes                         | Yes                          | A trusted caller explicitly forwards one allowed API-key variable through the Podman client environment, not argv.                                                                          |

### Use an existing host login for interactive work

`dev` defaults to `--auth host`. Pi stages only the `openai-codex` entry from `~/.pi/agent/auth.json`; OpenCode stages only the `openai` entry from `$XDG_DATA_HOME/opencode/auth.json` (or `~/.local/share/opencode/auth.json`). You must already be signed in to that provider through the selected host agent.

```sh
./pi-pod dev /path/to/your-project
./pi-pod dev /path/to/your-project --agent opencode
```

Each session receives a fresh private stage. Concurrent host-auth dev sessions are supported, no host credential directory is mounted, and pi-pod never writes the staged credential back. For another provider, use a supported profile or API key.

`run` and library-autonomous use never read host Pi/OpenCode credentials, settings, extensions, sessions, skills, analytics, or shell configuration. `run --auth host` is rejected before workspace, state, or Podman side effects.

### Create a profile for tasks

Use a profile for native subscription login. For Pi:

```sh
./pi-pod login --agent pi --provider openai-codex --profile worker
```

Complete the device-code flow and exit Pi with `/quit`. Then select the profile for a task or an interactive session:

```sh
./pi-pod run /path/to/your-project --auth worker --prompt "Fix the failing unit tests"
./pi-pod dev /path/to/your-project --auth worker
```

For OpenCode, use `login --agent opencode --provider <provider-id> --profile worker` and include `--agent opencode --auth worker` when launching. Provider identifiers and supported credential forms are listed in [supported agents](agents.md#authentication-identifiers).

Without `--auth`, `run` selects the pi-pod profile named `default`; you can create it with `login --agent pi --provider openai-codex --profile default`. A profile belongs to one agent and provider and persists only the selected native provider credential under `$XDG_STATE_HOME/pi-pod/auth/` (or `~/.local/state/pi-pod/auth/`). One container uses a profile at a time because the agent may refresh and persist the credential. Use separate named profiles for concurrent tasks.

### Forward an API key

With the key already set in your shell, pass its **variable name**, not its value:

```sh
./pi-pod run /path/to/your-project --auth none --env ANTHROPIC_API_KEY --prompt "Summarize the repository"
```

The same `--auth none --env NAME` options work with `dev`. Values stay in the Podman client environment, not argv. Names are validated against a narrow allowlist policy; forge, SSH, database, proxy, cloud-secret, and unrelated credential variables are rejected. Never pass a credential if repository code run by the agent must not receive it.

## Recover an interrupted profile

If pi-pod reports an interrupted stage, use the named command indicated by the diagnostic. These are separate recovery actions, not a sequence to run after every task:

```sh
./pi-pod auth recover --agent pi --profile worker
./pi-pod auth discard --agent pi --profile worker
./pi-pod auth unlock --agent pi --profile worker
```

Use recovery only when the command reports an interrupted stage and verifies its recorded container is absent. `discard` removes an unwanted retained stage; `unlock` removes only a stale lock whose PID and exact container are gone. Do not delete the auth state tree as a troubleshooting shortcut.

## Lifecycle outcomes

| Outcome                                                            | Workspace                                             | Auth stage/profile lock                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Normal exit or nonzero agent exit after verified container removal | Clone retained; bind untouched                        | Selected profile credential is reconciled; stage is removed and lock released. Host stage is discarded without copy-back. |
| Timeout or abort after verified container removal                  | Clone retained; bind untouched                        | Same reconciliation/discard path applies.                                                                                 |
| Setup failure before launch                                        | Acquired clone preparation is removed; bind untouched | Any acquired lock is released; no completed execution result is returned.                                                 |
| Container removal cannot be verified                               | Clone reservation retained                            | Credential, prompt, and resource stages remain private; profile lock remains retained.                                    |
| Credential reconciliation fails                                    | Clone retained                                        | Private stage is retained for guarded recovery; the result/CLI reports recovery is needed.                                |

## Required manual OAuth validation for autonomous profiles

Real provider login, credential reuse, and refresh require user-assisted validation; automated tests use fake credentials. This procedure cannot run in CI and must never expose a token. After building the image, use a disposable empty directory and a named profile:

1. Run `./pi-pod login --agent pi --provider openai-codex --profile v01-check` and complete Pi's device-code flow. Exit with `/quit`.
2. In a fresh process, run `./pi-pod run /path/to/empty-dir --workspace bind --auth v01-check --prompt "Reply only: AUTH_OK" --timeout 60`; confirm it does not ask to log in again.
3. Repeat after provider refresh/expiry timing permits.
4. For every intended OpenCode subscription provider, repeat the login with `--agent opencode --provider <provider-id>` and the task with `--agent opencode --auth v01-check`. Use a distinct profile name for each provider, replacing `v01-check` in both commands.

Record only provider name, command exit status, and whether reuse/refresh succeeded. Do not inspect, print, or copy tokens, device codes, or redirect URLs.
