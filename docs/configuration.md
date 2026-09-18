# Model preferences

Set your preferred model and thinking level or variant once, or override them per session with [native agent flags](usage.md#options-and-passthrough).

## Supported preferences

pi-pod supports a bounded JSON preference file for model selection and one verified agent-native behavior preference. It is not an auth profile, native-settings passthrough, resource catalog, or Podman policy.

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
| `dev --no-config`                  | Skips only this pi-pod preference-file layer.                                                                |
| `dev --config /absolute/path.json` | Uses only that file instead of the automatic file.                                                           |
| `run`                              | Never discovers personal configuration.                                                                      |
| `run --config /absolute/path.json` | Explicitly loads only the selected agent's `run` section.                                                    |
| Library API                        | Accepts typed `preferences`; it never loads files.                                                           |

`--config` must be absolute. It and `--no-config` are mutually exclusive. Missing automatic configuration is allowed; a missing, unreadable, symlinked, oversized, or invalid selected file fails before delegation, auth, workspace, or Podman side effects. There is no cwd/ancestor search, `.env` discovery, shell interpolation, dynamic import, file creation, or host configuration modification.

For each field, precedence is: built-in default, then Pi's current interactive filtered host preference subset, then the selected file section, then matching native flags after `--`. If native passthrough supplies Pi `--provider` or `--model`, it replaces the configured model atomically; `--thinking`, OpenCode `--model`/`-m`, and `--variant` similarly override their matching configured field. pi-pod emits no duplicate managed preference flag.

## Not supported yet

The complete [design example](plans/04-agent-configuration.example.json) includes `resources` arrays. They are deliberately rejected in the current model-preferences implementation (plan phase D1), including empty arrays: trusted local resource-catalog resolution and exact mounts are future D2 review work. Existing [interactive Pi host extension behavior](agents.md#interactive-pi-extensions) is unchanged; `--no-config` does not disable it. No configuration file can contain credentials, environment forwarding, arbitrary host paths, commands, plugins/resources, Podman options, mounts, privileged mode, disabled hardening, or analysis settings.
