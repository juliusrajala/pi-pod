# pi-pod

**Run Pi or OpenCode in a container, with access to the project you choose.**

pi-pod gives your coding agent a rootless Podman workspace with selected credentials and resource limits. Use it interactively in your working directory, or give it a task in a separate clone that you review afterward. Available as a CLI and a [Bun library](docs/library.md) for local and self-hosted use.

- **Work alongside an agent:** `dev` edits your project directly.
- **Hand off a task:** `run` works in a clean clone and keeps the result for review.
- **Control what it receives:** one writable project mount, selected authentication, and no general host-home access.

[Get started](#quick-start) · [Usage guide](docs/usage.md) · [All docs](docs/README.md) · [Security](docs/security.md)

## Quick start

### 1. Build the CLI and agent image

You need **Linux x64**, **rootless Podman** with cgroup v2, and **Git**. Some terminal environments also need `systemd-run --user` for CPU limits. Use **Bun 1.3.14** to build the compiled CLI below; Bun is not needed to run it. Already have a bundle? Start with [bundle setup](docs/installation.md#set-up-the-bundle).

```sh
git clone https://github.com/juliusrajala/pi-pod.git
cd pi-pod
bun install
bun run build:release -- --target linux-x64
cd dist/pi-pod-linux-x64
sha256sum --check SHA256SUMS
./pi-pod build
```

`build:release` compiles the CLI; `./pi-pod build` builds the Podman image containing both agents and common development tools. Keep the executable alongside its bundled `container/` directory. Run the examples below from the bundle directory, replacing `/path/to/your-project` with your project directory. See [installation](docs/installation.md) for details.

### 2. Start an interactive session

Already signed in to Codex through Pi or OpenCode on your host? `dev` uses that agent's selected credential in a private session; it never writes it back to your host agent.

```sh
# Pi (the default agent)
./pi-pod dev /path/to/your-project

# Or OpenCode
./pi-pod dev /path/to/your-project --agent opencode
```

**Edits happen directly in your project.** It can have uncommitted changes. For other credentials, use a [pi-pod profile or an explicit API key](docs/authentication.md#choose-authentication).

### 3. Hand off a task in a separate clone

Headless tasks use their own authentication. Create a pi-pod profile, then run a task against a **clean Git repository**:

```sh
./pi-pod login --agent pi --provider openai-codex --profile worker
./pi-pod run /path/to/your-project --auth worker --prompt "Fix the failing unit tests"
```

Complete the login flow and exit Pi with `/quit` before running the task. Prefer an API key? With `ANTHROPIC_API_KEY` already set in your shell:

```sh
./pi-pod run /path/to/your-project --auth none --env ANTHROPIC_API_KEY --prompt "Summarize the repository"
```

The clone includes local committed `HEAD`, even unpushed commits, but not uncommitted, ignored, or untracked files. Tasks default to a **10-minute timeout**. When the task ends, pi-pod prints the retained clone's path and run ID. Review the result there; pi-pod does not copy changes back, commit, push, or open a PR for you. Remove the clone when you're done:

```sh
./pi-pod remove <run-id>
```

See the [usage guide](docs/usage.md) for OpenCode tasks, prompt files, dependencies, workspace choices, and all options.

## The boundary, in brief

Agents run with a read-only image, dropped capabilities, and CPU, memory, process, and storage controls. They get no host home, SSH agent, or Podman socket. Interactive Pi can load [selected read-only host extensions](docs/agents.md#interactive-pi-extensions); headless work never imports host agent credentials or resources.

The project you expose is writable, including any `.env` files in it. Repository code can read credentials you supply. Outbound networking is enabled by default, storage monitoring is not a hard quota, and containers share the host kernel. Read the [security guarantees and limits](docs/security.md) for the full boundary.

## Go further

| I want to…                             | Read                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Install or troubleshoot my setup       | [Installation](docs/installation.md) · [Troubleshooting](docs/usage.md#troubleshooting)                          |
| Choose an agent, model, or credentials | [Agents](docs/agents.md) · [Model preferences](docs/configuration.md) · [Authentication](docs/authentication.md) |
| Integrate pi-pod into my own tools     | [Library API](docs/library.md)                                                                                   |
| Understand or contribute to pi-pod     | [Architecture](docs/architecture.md) · [Development and tests](docs/development.md)                              |

## License

pi-pod is source-available under the Apache License 2.0 with the Commons Clause License Condition v1.0. You may use, modify, and redistribute it subject to those terms; the license does not grant the right to sell software or services whose value derives entirely or substantially from pi-pod. See [LICENSE](LICENSE).
