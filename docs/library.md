# Library API

The library is for a trusted host caller. It does not turn untrusted agent requests into authorized workspace, image, credential, or resource choices.

```ts
import { runAgent } from "pi-pod";

const result = await runAgent({
  agent: "opencode",
  mode: "headless",
  workspace: "/srv/jobs/job-123/workspace",
  workspaceMode: "bind",
  auth: { type: "profile", name: "worker" },
  prompt: "Implement the requested change and run relevant tests.",
  preferences: { model: { provider: "anthropic", id: "your-model-id" }, variant: "high" },
  timeoutMs: 10 * 60_000,
});
```

`preferences` is typed, validated agent-native input; `runAgent` never reads a configuration file or CLI authentication defaults. Headless calls require `auth: { type: "profile", name }`; host authentication is not an accepted headless option and fails before host credential, workspace, state mutation, or Podman side effects. Generic environment/API-key forwarding is not a library option.

`RunResult` distinguishes agent termination, verified container removal, retained-clone reservation disposition, source-only credential-stage cleanup, and output delivery. Setup failures still throw rather than returning a separate result format. A clone that reached startup remains under pi-pod state until `removeAgentRun` removes it after guarded checks.

Trusted callers may supply Web `WritableStream<Uint8Array>` sinks as `output.stdout` and `output.stderr`; lifecycle delivery applies backpressure. Omitting them inherits the terminal. `AbortSignal` cancellation stops the exact container and retains a stage when removal cannot be verified.

Exports include `runAgent`, `removeAgentRun`, `prepareWorkspace`, and `buildPodmanRunArgs`. See [authentication.md](authentication.md) and [architecture.md](architecture.md) before composing lower-level calls.
