# Pi-pod configuration

Set your preferred model and thinking level or variant once, or override them per session with [native agent flags](usage.md#options-and-passthrough).

## Supported preferences

pi-pod supports a bounded JSON file for model preferences and explicit interactive Pi package copies. It is not an auth profile, native-settings passthrough, or Podman policy.

```json
{
  "version": 1,
  "agents": {
    "pi": {
      "dev": {
        "model": { "provider": "openai-codex", "id": "your-model-id" },
        "preferences": { "thinking": "high" }
      }
    }
  }
}
```

`model.provider` and `model.id` are required together and are passed atomically. Pi translates them to `--provider` and `--model`; it accepts `thinking` values `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. OpenCode translates the same object to `--model provider/id` and accepts a nonempty provider-native `variant` string. See copyable non-secret examples: [Pi](../config/agents/pi.dev.json) and [OpenCode](../config/agents/opencode.dev.json). Replace `your-model-id` with a model available to your selected agent/provider.

## Loading

| Invocation                         | Behavior                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `dev`                              | Optionally loads `$XDG_CONFIG_HOME/pi-pod/config.json`, or `~/.config/pi-pod/config.json` when XDG is unset. |
| `dev --no-config`                  | Skips this configuration layer, including explicit package copies; legacy host extensions still apply.       |
| `dev --config /absolute/path.json` | Uses only that file instead of the automatic file.                                                           |
| `run`                              | Never discovers personal configuration.                                                                      |
| `run --config /absolute/path.json` | Explicitly loads only the selected agent's `run` section.                                                    |
| Library API                        | Accepts typed `preferences`; it never loads files.                                                           |

`--config` must be absolute. It and `--no-config` are mutually exclusive. Missing automatic configuration is allowed; a missing, unreadable, symlinked, oversized, or invalid selected file fails before delegation, auth, workspace, or Podman side effects. There is no cwd/ancestor search, `.env` discovery, shell interpolation, dynamic import, file creation, or host configuration modification.

For each field, precedence is: built-in default, then Pi's current interactive filtered host preference subset, then the selected file section, then matching native flags after `--`. If native passthrough supplies Pi `--provider` or `--model`, it replaces the configured model atomically; `--thinking`, OpenCode `--model`/`-m`, and `--variant` similarly override their matching configured field. pi-pod emits no duplicate managed preference flag.

## Not supported yet

The archived [design example](plans/archive/04-agent-configuration.example.json) includes resource-catalog `resources` arrays. That proposal has been superseded by the explicit package-copy selection below; its fields remain unsupported, including empty arrays. No configuration can contain credentials, environment forwarding, commands, arbitrary mounts, Podman options, privileged mode, or disabled hardening.

## Select local Pi packages

In `~/.config/pi-pod/config.json` (or the XDG/explicit configuration path), choose the packages copied into interactive Pi sessions:

```json
{
  "version": 1,
  "agents": {
    "pi": {
      "dev": {
        "packages": [
          {
            "source": "/home/you/code/pi-files",
            "files": ["package.json", "extensions", "src"],
            "extensions": ["extensions/example.ts"]
          }
        ]
      }
    }
  }
}
```

- `source` is the absolute path to a trusted local package checkout; it need not live under `~/.pi`.
- `files` lists literal relative files/directories to copy, including `package.json`. Include supporting code imported by extensions, such as `src`. Only these paths are copied; there is no implicit whole-repository copy or dependency installation.
- `extensions` uses Pi's package extension filters. Omit it to enable all package extensions, or use `[]` to enable none. Skills, prompts, and themes remain disabled.

Defining `packages` replaces automatic host package and direct-extension discovery for that session. Set `packages: []` to disable both. If the field is omitted, legacy host extension behavior still applies. Pi model defaults can still be inherited from host settings.

Each launch takes a fresh private snapshot. Snapshots are exposed read-only and cleaned after container removal; the original package checkout is never mounted or modified. Restart the session after editing package source; `/reload` sees the existing snapshot. No package changes are written back to host Pi. Symlinks and special files are rejected; copies are bounded to 32 MiB and 4096 entries across all packages. Use `-- --no-extensions` to skip extension staging entirely.

Selections apply only to `agents.pi.dev`. Headless and OpenCode sections reject them, and the public library does not load this configuration. Model preferences and package selection share the same file; see the [Pi example](../config/agents/pi.dev.json), which starts with an empty package selection.
