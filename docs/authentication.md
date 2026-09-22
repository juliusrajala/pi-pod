# Authentication

pi-pod has two credential sources: **host** and **profile**. A credential deliberately supplied to a container can be read or exfiltrated by repository code running there. Private staging limits host-state access and prevents write-back; it does not make an in-container credential secret.

## Host authentication

The local CLI defaults to the selected agent's reviewed host credential for both `dev` and `run`:

```sh
./pi-pod dev /path/to/project
./pi-pod run /path/to/project --prompt "Fix the failing tests"
```

Pi stages only `openai-codex` from `~/.pi/agent/auth.json`. OpenCode stages only `openai` from `$XDG_DATA_HOME/opencode/auth.json` (or its standard home fallback). It copies that one native credential to a fresh private stage, mounts only that stage, never mounts a host agent directory, and never writes changes back. The CLI can select host explicitly with `--auth host`.

This local CLI capability is not public-library behavior. Headless `runAgent` calls require an explicit pi-pod profile and never inspect host credentials or CLI defaults.

## API-token profiles

Profiles are pi-pod-owned, source-only API tokens bound to an agent and provider. Create one through the controlling terminal; the token is prompted without echo and is never accepted in argv:

```sh
./pi-pod auth profile create --agent opencode --provider anthropic --profile worker
./pi-pod run /path/to/project --agent opencode --auth worker --prompt "Fix the failing tests"
```

The currently verified matrix is deliberately small:

| Agent    | Provider    | Native stored shape                              | Validation                                 |
| -------- | ----------- | ------------------------------------------------ | ------------------------------------------ |
| OpenCode | `anthropic` | `{ "anthropic": { "type": "api", "key": "…" } }` | Pinned native codec and fixture validation |
| Pi       | —           | —                                                | No API-token profile is advertised yet     |

Manage profiles without displaying secret material:

```sh
./pi-pod auth profile list
./pi-pod auth profile show --agent opencode --profile worker
./pi-pod auth profile update --agent opencode --profile worker
./pi-pod auth profile remove --agent opencode --profile worker
```

Each run gets a separate stage from the stored source. Runs may use the same profile concurrently. Native changes to a stage are discarded, never reconciled to the profile. Updating a profile atomically affects future stages; removing it does not revoke copies in live containers.

Version-1/OAuth profile state is rejected with an instruction to remove and recreate it. pi-pod does not migrate or automatically delete legacy state.

## CLI defaults

The CLI chooses authentication in this order: invocation `--auth host|PROFILE`, selected agent's saved default, then built-in `host`. Defaults contain a source reference only:

```sh
./pi-pod auth default set --agent opencode --auth worker
./pi-pod auth default set --agent opencode --auth host
./pi-pod auth default show --agent opencode
./pi-pod auth default clear --agent opencode
```

A profile default must exist and belong to the selected agent. `host` is reserved; `none` is not an authentication source. Profile removal refuses while it is selected as that agent's default.

## Library callers

Headless library use is explicit and profile-only:

```ts
await runAgent({
  mode: "headless",
  workspace: "/srv/jobs/job-123/workspace",
  auth: { type: "profile", name: "worker" },
  prompt: "Fix the failing tests",
});
```

The library neither loads CLI defaults nor supports host authentication for headless work. It has no generic API-key environment forwarding option.
