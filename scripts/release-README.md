# pi-pod Linux x64 release bundle

This bundle contains the compiled pi-pod host controller and the audited
Containerfile it uses for `pi-pod build`. It supports Linux x86_64 only.

Requirements: rootless Podman, cgroup v2 resource limits, and Bun is **not**
required. Build the pinned agent image before the first agent run:

```sh
./pi-pod build
./pi-pod --help
```

Verify `SHA256SUMS` before use:

```sh
sha256sum --check SHA256SUMS
```

The executable remains a host controller. Pi and OpenCode run in the pinned
Podman image; this bundle does not provide either agent runtime. It does not
support macOS or Windows, and it does not download images, recipes, updates,
or credentials.
