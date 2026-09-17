# Library API

The library is for a trusted host caller. It does not turn untrusted agent requests into authorized workspace, image, credential, or resource choices.

```ts
import { runAgent } from "pi-pod";

const result = await runAgent({
  agent: "pi",
  mode: "headless",
  workspace: "/srv/jobs/job-123/workspace",
  workspaceMode: "bind",
  authProfile: "default",
  prompt: "Implement the requested change and run relevant tests.",
  preferences: { model: { provider: "openai-codex", id: "your-model-id" }, thinking: "high" },
  timeoutMs: 10 * 60_000,
});
```

`preferences` is typed, validated agent-native input; `runAgent` never reads a configuration file. `runAgent` resolves Pi by default, `bind` for interactive mode, `clone` for headless mode, `host` auth for interactive mode, and the `default` profile for headless mode. A headless `host` request throws before state, workspace, or Podman side effects.

`RunResult` distinguishes agent termination, verified container removal, retained-clone reservation disposition, credential reconciliation/lock status, and output delivery. Setup failures still throw rather than returning a separate result format. A clone that reached startup remains under pi-pod state until `removeAgentRun` removes it after guarded checks.

Trusted callers may supply Web `WritableStream<Uint8Array>` sinks as `output.stdout` and `output.stderr`; lifecycle delivery applies backpressure. Omitting them inherits the terminal. `AbortSignal` cancellation stops the exact container and keeps stages/locks when removal cannot be verified.

Exports also include `login`, `removeAgentRun`, `prepareWorkspace`, `recoverAuthProfile`, `discardPendingAuthStages`, `removeAuthProfileLock`, and `buildPodmanRunArgs`. See [authentication.md](authentication.md) and [architecture.md](architecture.md) before composing lower-level calls.
