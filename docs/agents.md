# Supported agents

Pi is the default; pass `--agent opencode` to select OpenCode. The [shared image](installation.md#agent-image), not a host-installed executable, determines the agent version. `--image` may select a compatible image, but pi-pod never pulls, builds, or discovers one automatically.

| Agent    | Image version | `dev` | `run` | Selected host credential | API-token profile support                                                          | Native discovery controls                                                                                                                                                                                                           |
| -------- | ------------- | ----- | ----- | ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi       | 0.85.1        | Yes   | Yes   | `openai-codex` only      | None advertised; its pinned API-key behavior is not yet verified                   | Headless disables extensions, skills, prompt templates, themes, context files, and project trust. Interactive dev may load filtered read-only Pi extension resources from `~/.pi/agent/extensions` and `~/.pi/agent/packages` only. |
| OpenCode | 1.18.27       | Yes   | Yes   | `openai` only            | `anthropic` API token: exact native `{ "type": "api", "key": "…" }` provider value | Uses `--pure`; bundled subscription integrations remain available. Project configuration merging is native OpenCode behavior inside the container.                                                                                  |

## Supported preferences

Model preferences support a common `{ "provider", "id" }` envelope for either agent and Pi `thinking` / OpenCode `variant` in the selected `dev` or explicit `run` section. Both agents' pinned CLI help was verified: Pi supports `--provider`, `--model`, and thinking `off|minimal|low|medium|high|xhigh|max`; OpenCode supports `--model provider/model` and provider-native `--variant`. Resource arrays are not yet supported and are rejected rather than silently ignored. See [model preferences](configuration.md).

## Authentication identifiers

Pi's `openai-codex` and OpenCode's `openai` identifiers are agent-native and not interchangeable. Local CLI host authentication stages only the selected credential in a fresh private directory for either `dev` or `run`; it never mounts or writes back the host directory. API-token profiles are a separate pi-pod-owned source and are limited to the compatibility matrix above. See [authentication](authentication.md).

Model/provider flags supplied directly to an agent can override wrapper preferences. pi-pod rejects only mismatches it can identify from an explicit wrapper preference/profile combination; it cannot validate arbitrary native project configuration that an agent reads inside the container.

## Interactive Pi extensions

Interactive Pi `dev` loads trusted host Pi extensions by default. The direct `~/.pi/agent/extensions` directory and package roots declared under `~/.pi/agent/extensions` or `~/.pi/agent/packages` in host settings are mounted read-only. pi-pod generates filtered settings containing only package declarations and Pi model defaults.

It does not mount general settings, sessions, skills, themes, analytics, credentials, or remote package sources through this resource path. Credentials are staged separately as described above. To disable extension loading, pass Pi's native flag:

```sh
./pi-pod dev /path/to/your-project -- --no-extensions
```

`--no-config` only skips the pi-pod model preference file; it does not disable these extensions. Headless Pi never loads these host resources. OpenCode does not import host settings, plugins, sessions, or configuration.

## Known limits

- Agents run repository code inside the container. Any supplied credential may be read or exfiltrated by that code.
- API-token compatibility is intentionally restricted to combinations with pinned native-shape evidence; unsupported combinations fail at profile creation.
- Pi's filtered interactive resources are Pi-only. OpenCode does not discover or import host settings, plugins, sessions, or configuration.
- No third agent is supported or implied. See the contributor checklist in [development.md](development.md) before proposing one.
