# Supported agents

Pi is the default; pass `--agent opencode` to select OpenCode. The [shared image](installation.md#agent-image), not a host-installed executable, determines the agent version. `--image` may select a compatible image, but pi-pod never pulls, builds, or discovers one automatically.

| Agent    | Image version | `dev` | `run` | Interactive host auth        | Wrapper profile                                                 | Explicit API key    | Native discovery controls                                                                                                                                                                                                               |
| -------- | ------------- | ----- | ----- | ---------------------------- | --------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi       | 0.85.1        | Yes   | Yes   | Selected `openai-codex` only | `openai-codex` OAuth only                                       | Yes, named variable | Headless disables extensions, skills, prompt templates, themes, context files, and project trust. Interactive dev may load the filtered read-only Pi extension resources from `~/.pi/agent/extensions` and `~/.pi/agent/packages` only. |
| OpenCode | 1.18.27       | Yes   | Yes   | Selected `openai` only       | Native `oauth`, `api`, or `wellknown` selected credential forms | Yes, named variable | Uses `--pure`; bundled subscription integrations remain available. Project configuration merging is native OpenCode behavior inside the container.                                                                                      |

## Supported preferences

Model preferences support a common `{ "provider", "id" }` envelope for either agent and Pi `thinking` / OpenCode `variant` in the selected `dev` or explicit `run` section. Both agents' pinned CLI help was verified: Pi supports `--provider`, `--model`, and thinking `off|minimal|low|medium|high|xhigh|max`; OpenCode supports `--model provider/model` and provider-native `--variant`. Resource arrays are not yet supported and are rejected rather than silently ignored. See [model preferences](configuration.md).

## Authentication identifiers

Pi's `openai-codex` and OpenCode's `openai` identifiers are agent-native and not interchangeable. A profile belongs to one agent and provider. `login` invokes the agent-native flow:

```sh
./pi-pod login --agent pi --provider openai-codex --profile worker
./pi-pod login --agent opencode --provider <provider-id> --profile worker
```

A host credential is an interactive-development convenience, not a general source. Pi reads only `~/.pi/agent/auth.json`'s selected `openai-codex` value; OpenCode reads only `$XDG_DATA_HOME/opencode/auth.json` (with the standard home fallback)'s selected `openai` value. Each interactive session gets a fresh private stage, so concurrent host-auth dev sessions are supported. Neither host directory is mounted or copied back. `run` rejects `--auth host` before state, workspace, or Podman side effects.

## Interactive Pi extensions

Interactive Pi `dev` loads trusted host Pi extensions by default. The direct `~/.pi/agent/extensions` directory and package roots declared under `~/.pi/agent/extensions` or `~/.pi/agent/packages` in host settings are mounted read-only. pi-pod generates filtered settings containing only package declarations and Pi model defaults.

It does not mount general settings, sessions, skills, themes, analytics, credentials, or remote package sources through this resource path. Credentials are staged separately as described above. To disable extension loading, pass Pi's native flag:

```sh
./pi-pod dev /path/to/your-project -- --no-extensions
```

`--no-config` only skips the pi-pod model preference file; it does not disable these extensions. Headless Pi never loads these host resources. OpenCode does not import host settings, plugins, sessions, or configuration.

## Known limits

- Real provider OAuth login, reuse, and refresh remain user-assisted validation; automated tests use fake credentials only.
- Agents run repository code inside the container. Any credential explicitly supplied to an agent may be read or exfiltrated by that code.
- Pi's filtered interactive resources are Pi-only. OpenCode does not discover or import host settings, plugins, sessions, or configuration.
- No third agent is supported or implied. See the contributor checklist in [development.md](development.md) before proposing one.
