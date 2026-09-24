# Installation

Use `bun run build` from the checkout to build the **compiled CLI and its matching agent image together**, or [set up an existing bundle](#set-up-the-bundle).

## Requirements

- **Native Linux x64 (`linux/amd64`).** macOS, Windows, and Linux arm64 are not currently supported.
- **Local rootless Podman** with cgroup v2 resource controllers. Remote Podman services and Podman Machine are not supported.
- **A working user systemd session** with `systemd-run --user` when your terminal scope does not delegate CPU control. pi-pod can re-execute in a delegated user scope.
- **Git** for clone workspaces.
- **Bun 1.3.14 or later**, installed normally and available on PATH, to build or develop from source. No Mise or private Bun installation is required. Running the compiled bundle does not require Bun.

Run Podman and pi-pod as your regular user, without `sudo`. Building the image requires network access to retrieve its base image and dependencies.

## Build from source

Run from the trusted pi-pod checkout:

```sh
git clone https://github.com/juliusrajala/pi-pod.git
cd pi-pod
bun install --frozen-lockfile
bun run build
```

The build compiles and verifies a Linux x64 bundle, smoke-tests its startup from a hostile workspace, and builds the matching Podman agent image. Only then does it update `dist/latest` and the stable `./pi-pod` entrypoint. A successful command means both artifacts are ready.

The version comes from `package.json`: currently `dist/pi-pod-0.3.1-linux-x64/` and `localhost/pi-pod:0.3.1`. The bundle contains the executable, image recipe and locked dependencies, README, and checksums.

Run the same command after source or image changes. It always recompiles current source and lets Podman reuse cached image layers. Same-version bundles are retained as `dist/pi-pod-<version>-linux-x64.previous-<id>` before replacement. A failed compile, verification, or image build leaves the previous bundle and `dist/latest` intact. A forcibly killed build may leave `dist/.build-lock`; remove that directory only after confirming no build is running.

## Set up the bundle

This section is for a bundle copied or downloaded separately. Source builds already complete these steps with `bun run build`. Enter the extracted bundle directory, verify checksums, then build the local agent image:

```sh
sha256sum --check SHA256SUMS
./pi-pod build
./pi-pod --help
```

Keep `pi-pod` alongside its bundled `container/` directory, which contains the audited `Containerfile` and locked image dependency files. Move the whole bundle if you want to keep it outside the source checkout.

The portable bundle does not contain the Podman image. Its `build` subcommand installs that image on the receiving machine. Native Linux, rootless Podman, and cgroup v2 are still required when running the compiled CLI.

## Use it with your project

From the checkout (or an extracted bundle), pass the path of the project you want to work on:

```sh
./pi-pod dev /path/to/your-project
```

From your project directory, use the stable checkout entrypoint:

```sh
/path/to/pi-pod/pi-pod dev .
```

The usage guides use `./pi-pod`, available from either the checkout or a bundle directory. Authentication is required for model requests. `dev` defaults to the selected host Codex credential; see [authentication](authentication.md#choose-authentication) for profiles and API keys.

For nonstandard Podman or Git installations, set `PI_POD_TRUSTED_PATH` to an explicitly trusted absolute tool directory; caller PATH entries are not inherited. The compiled CLI disables Bun's dotenv, bunfig, tsconfig, and package.json autoloading. See [architecture](architecture.md#host-startup-paths) for the startup boundary.

## Local Bun package

The source is public, but the package remains private and is not published to a registry. A trusted local Bun consumer can install from a checkout:

```sh
bun add /path/to/pi-pod
```

Linked/installed packages expose `pi-pod` and the legacy `pi-pod-dev` alias through the source launcher, rather than the compiled CLI. They require Bun 1.3.14 or later. See the [library API](library.md) for programmatic use, or [development](development.md#source-launcher) to work on the CLI without recompiling it.

## Agent image

The default image is `localhost/pi-pod:0.3.1`. It contains:

| Component         | Version / tools                    |
| ----------------- | ---------------------------------- |
| Pi                | 0.87.1                             |
| OpenCode          | 1.18.27                            |
| Bun               | 1.3.14                             |
| Development tools | Node/npm, Git, Bash, `fd`, ripgrep |

The build pins the Node base digest, validates Bun's download checksum, and installs the agents from a checked-in Bun lockfile with integrity records and install scripts disabled. The image currently targets `linux/amd64` only.

Launches never pull or build an image automatically. Run `bun run build` from source before your first session and after changes. A project may need additional dependencies or toolchains; see [workspace dependencies](usage.md#workspace-dependencies-and-toolchains) and the [agent support matrix](agents.md).

**Next:** [Start an interactive session or run a task](usage.md), or consult [troubleshooting](usage.md#troubleshooting).
