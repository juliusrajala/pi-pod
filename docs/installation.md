# Installation

Use the **compiled CLI** for everyday use. Build a Linux x64 bundle from source below, or [set up an existing bundle](#set-up-the-bundle). The CLI then builds a separate Podman image containing Pi and OpenCode.

## Requirements

- **Native Linux x64 (`linux/amd64`).** macOS, Windows, and Linux arm64 are not currently supported.
- **Local rootless Podman** with cgroup v2 resource controllers. Remote Podman services and Podman Machine are not supported.
- **A working user systemd session** with `systemd-run --user` when your terminal scope does not delegate CPU control. pi-pod can re-execute in a delegated user scope.
- **Git** for clone workspaces.
- **Bun 1.3.14** to compile the CLI from source. The release build requires this exact version, pinned in `.mise.toml`. Running the compiled bundle does not require Bun.

Run Podman and pi-pod as your regular user, without `sudo`. Building the image requires network access to retrieve its base image and dependencies.

## Build the CLI from source

Run from the trusted pi-pod checkout using Bun 1.3.14:

```sh
git clone https://github.com/juliusrajala/pi-pod.git
cd pi-pod
bun install
bun run build:release -- --target linux-x64
bun run verify:release -- dist/pi-pod-linux-x64
```

If you use Mise, prefix the Bun commands with `mise exec --` to select the repository-pinned runtime.

This produces `dist/pi-pod-linux-x64/`, containing the executable, image recipe and locked dependencies, bundle README, and checksums. It also smoke-tests the compiled CLI's help command from a workspace with hostile startup configuration. The agent image is built in the next step.

The build refuses to overwrite an existing `dist/pi-pod-linux-x64` directory. If rebuilding, move the previous bundle to a location you want to keep before running the build again.

## Set up the bundle

From a source build, enter `dist/pi-pod-linux-x64`. If you already have a bundle, enter its extracted directory instead. Verify checksums, then build the agent image:

```sh
sha256sum --check SHA256SUMS
./pi-pod build
./pi-pod --help
```

Keep `pi-pod` alongside its bundled `container/` directory, which contains the audited `Containerfile` and locked image dependency files. Move the whole bundle if you want to keep it outside the source checkout.

`build:release` compiles the **host CLI**; `./pi-pod build` builds the **agent image**. The bundle does not contain the image. Native Linux, rootless Podman, and cgroup v2 are still required when running the compiled CLI.

## Use it with your project

From the bundle directory, pass the path of the project you want to work on:

```sh
./pi-pod dev /path/to/your-project
```

From your project directory, use the absolute path to the compiled executable:

```sh
/path/to/pi-pod-linux-x64/pi-pod dev .
```

The usage guides use `./pi-pod` from the bundle directory. Authentication is required for model requests. `dev` defaults to the selected host Codex credential; see [authentication](authentication.md#choose-authentication) for profiles and API keys.

For nonstandard Podman or Git installations, set `PI_POD_TRUSTED_PATH` to an explicitly trusted absolute tool directory; caller PATH entries are not inherited. The compiled CLI disables Bun's dotenv, bunfig, tsconfig, and package.json autoloading. See [architecture](architecture.md#host-startup-paths) for the startup boundary.

## Local Bun package

The source is public, but the package remains private and is not published to a registry. A trusted local Bun consumer can install from a checkout:

```sh
bun add /path/to/pi-pod
```

Linked/installed packages expose `pi-pod` and the legacy `pi-pod-dev` alias through the source launcher, rather than the compiled CLI. They require Bun 1.3.14 or later. See the [library API](library.md) for programmatic use, or [development](development.md#source-launcher) to work on the CLI without recompiling it.

## Agent image

The default image is `localhost/pi-pod:0.1.0`. It contains:

| Component         | Version / tools                    |
| ----------------- | ---------------------------------- |
| Pi                | 0.85.1                             |
| OpenCode          | 1.18.27                            |
| Bun               | 1.3.14                             |
| Development tools | Node/npm, Git, Bash, `fd`, ripgrep |

The build pins the Node base digest, validates Bun's download checksum, and installs the agents from a checked-in Bun lockfile with integrity records and install scripts disabled. The image currently targets `linux/amd64` only.

Launches never pull or build an image automatically. Run `build` before your first session and after updating the image recipe. A project may need additional dependencies or toolchains; see [workspace dependencies](usage.md#workspace-dependencies-and-toolchains) and the [agent support matrix](agents.md).

**Next:** [Start an interactive session or run a task](usage.md), or consult [troubleshooting](usage.md#troubleshooting).
