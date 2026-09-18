# pi-pod Linux x64 release bundle

Run Pi or OpenCode in a rootless Podman workspace. This bundle contains the compiled
pi-pod CLI and the audited `container/Containerfile` and locked image dependencies.
Keep the executable alongside the `container/` directory.

Requirements: native Linux x86_64, local rootless Podman, cgroup v2 resource limits,
Git for clone workspaces, and `systemd-run --user` when your terminal scope does not
delegate CPU control. **Bun is not required.**

## Get started

From the bundle directory, verify the checksums before running the CLI, then build
the agent image:

```sh
sha256sum --check SHA256SUMS
./pi-pod build
./pi-pod --help
```

Start an interactive session using your existing host Pi Codex login:

```sh
./pi-pod dev /path/to/your-project
```

This edits your project directly. Add `--agent opencode` to use OpenCode and its
selected host login instead. For a headless task in a retained clone, use `run`
with a pi-pod profile or explicit API key.

- [Usage and reviewing task results](https://github.com/juliusrajala/pi-pod/blob/main/docs/usage.md)
- [Authentication and recovery](https://github.com/juliusrajala/pi-pod/blob/main/docs/authentication.md)
- [Security guarantees and limits](https://github.com/juliusrajala/pi-pod/blob/main/docs/security.md)

The executable is the host controller; Pi and OpenCode run in the separately built
Podman image. Launches never pull or build images automatically. macOS, Windows,
and Linux arm64 are not supported.
