# Opt-in analysis traces and host-side delivery

**Status: planned and not implemented.** This follows the autonomous-validation closeout in Plan 02. It does not enable analytics implicitly or change the existing default privacy boundary. Current supported configuration is documented in [docs/configuration.md](../docs/configuration.md); this plan preserves the proposal and its required policy decisions.

## Goal

Collect a durable, structured, opt-in trace for a Pi-pod run so a trusted analysis service can reconstruct:

```text
prompt → interaction → turns → selected skills → tool calls → outcomes/failures → settled/completed run
```

The trace is for prompts, action chains, skill/tool use, and safe failure analysis. A full conversation transcript is a separate, stricter opt-in capability, not a prerequisite for this goal.

## What exists today

The trusted local `pi-files` package's `pi-usage-analytics` extension writes one JSONL sidecar per Pi session/runtime. It already records session/interaction IDs, prompt counts and sizes, skill names, tool name/duration/byte counts/error flag, permission denials, model usage, compaction outcomes, and settled/shutdown events.

It intentionally excludes prompt text, assistant text, tool inputs/results, paths, credentials, and raw errors. The current Pi-pod interactive command also uses `pi --no-session`, and the sidecar is written below the transient auth stage. Therefore it is useful evidence during a live session but is neither a durable artifact nor a transcript after cleanup.

## Non-goals

- Do not silently capture or upload any data from ordinary `dev` or `run` invocations.
- Do not upload from a Pi lifecycle handler, make a Pi extension hold an API token, or put an endpoint/token in container argv, environment, settings, or diagnostics.
- Do not import host Pi sessions, analytics, settings, extensions, package roots, or credentials into autonomous runs.
- Do not upload raw assistant thinking, attachments, complete tool results, repository contents, paths, environment values, or credentials by default.
- Do not use terminal/TTY scraping as a transcript format.
- Do not add a daemon, generic telemetry configuration discovery, or an orchestrator integration.
- Do not treat heuristic redaction as a guarantee that arbitrary prompt/tool text contains no secret.

## Required policy decisions before implementation

The trusted caller must explicitly select an analysis policy. No `HOME`- or project-discovered setting may enable it.

1. **Destination and authentication.** Define the exact ingestion URL, accepted schemes (HTTPS by default; narrowly define any local HTTP exception), request authentication source, response/receipt format, retention period, and deletion authorization. The delivery secret is host-uploader-only.
2. **Capture tier.** Define separate, opt-in tiers rather than one ambiguous `analytics` switch:
   - `metadata`: the current content-free metrics;
   - `trace`: prompt text plus normalized action/failure fields needed for chain analysis;
   - `transcript`: a separately approved representation of user/assistant/tool content.
3. **Prompt and action treatment.** Specify maximum record and total-run sizes, allowed text fields, deterministic redaction/normalization rules per built-in tool, whether shell commands are stored in plaintext, and the visible indication/consent for interactive use. A hash/fingerprint is not a replacement for plaintext if analysts need the action itself.
4. **Failure treatment.** Record stable categories, safe exit/status fields, and retry/timeout/abort state. Raw exception text or tool output requires an explicit content policy.
5. **Delivery semantics.** Define an idempotency key, duplicate behavior, retry/backoff limits, manual flush command, retention of failed uploads, and whether an unreachable analytics endpoint may affect the agent exit status. It must never hide the agent's result or broaden mounts/network access.
6. **Scope.** Decide whether the first emitter is Pi-only and whether it is a Pi-pod-owned, version-pinned extension. Do not make headless `run` inherit the developer's `pi-files` package. OpenCode capture needs its own explicitly reviewed adapter.

Document these decisions in the README and the ingest API contract before code writes any content.

## Architecture

### 1. Wrapper-owned capture and queue

Create a private wrapper state tree, separate from auth staging and from an owned clone, for example:

```text
$XDG_STATE_HOME/pi-pod/analysis/
  active/<trace-id>/       # only while exact container is verified live
  pending/<trace-id>/      # immutable wrapper queue item awaiting delivery
  delivered/<trace-id>/    # optional bounded receipt/audit metadata, never content
```

- The wrapper creates the per-run directory and keeps its control manifest outside the agent-writable payload directory.
- Mount only the payload child at one fixed container path, writable only when the caller selected capture. The exact directory is passed only to the reviewed emitter through a fixed Pi-pod setting/environment contract.
- The agent may write the mounted payload, so every file is untrusted: bounded file count/size, regular-file/no-symlink descriptor reads, JSONL/schema validation, and no trust in agent-written completion metadata.
- The wrapper owns run outcome, completion state, trace ID, and container identity. It appends/records those from host lifecycle results rather than accepting them from the agent.
- If cleanup cannot prove that the exact container was removed, do not read, move, upload, or delete the active payload. Retain it for guarded recovery just as credentials are retained.
- Once removal is verified, validate and atomically move the artifact into `pending`. Retain it until a verified successful delivery; no content belongs in auth staging.

### 2. Reviewed Pi emitter

Use an explicitly named, version-pinned, Pi-pod-owned emitter whenever capture is requested. It must be loaded through generated minimal settings/mounts, not through automatic discovery of host extensions or package settings.

Keep the existing content-free `pi-usage-analytics` schema stable. Add a separate trace schema/version (or a clearly versioned extension of it) with:

- a per-file sequence number in addition to timestamps;
- stable `traceId`, runtime/session, interaction, turn, tool-call, and leaf correlation fields;
- a `run` terminal record supplied or finalized by the wrapper;
- event records for prompt acceptance, selected/requested skills, tool start/end, permission denial, turn/agent state, compaction, model use, and settlement;
- safe, documented failure categories and terminal state;
- content only at the approved capture tier.

For `trace`, add only the prompt/action fields selected in the policy. Tool inputs need per-tool normalizers; unknown tools must default to metadata-only. Never serialize a full Pi event object. Do not collect assistant reasoning. A separate `transcript` tier must define exact message roles/content blocks, treatment of tool outputs and images, size caps, and completion/partial markers.

Pi's ephemeral session API/events are sufficient to emit structured records while `--no-session` remains in effect. Do not remove that privacy/control flag merely to obtain a session file.

### 3. Host-side delivery

Delivery runs after the agent lifecycle, outside the container and outside Pi event handlers. Implement an explicit host-side upload/flush operation rather than a background daemon.

- The trusted caller/library supplies an approved endpoint and host-only credential reference under the policy above. Never forward it to the agent.
- Submit validated queue items with a schema version, trace ID, run/session identifiers, and an idempotency key. Do not log request headers, tokens, prompt/action content, or response bodies.
- A 2xx response containing the documented receipt is the only deletion condition. Network, parsing, or non-success failures leave the item pending and return structured delivery status.
- A caller can explicitly retry pending items; bounded retries must not delay or alter container cleanup.
- Authentication/upload failures are reported alongside, but do not overwrite, the agent exit/timeout/abort result.

### 4. Public API and CLI

After the policy is fixed, add a small typed `analysis` option to the trusted library API and matching explicit CLI flags. Validate them before workspace, state, Podman, prompt, or credential side effects.

The result should distinguish at least:

```text
disabled | active-retained | pending | delivered | delivery-failed
```

Include only trace IDs and safe status/error categories in diagnostics/result metadata. A destination/token/content payload must never enter Podman argv, container environment, agent-visible settings, or normal CLI diagnostics.

## Implementation checkpoints

### A. Contract and schema first

1. Write the API ingest contract and README privacy/retention documentation.
2. Define schema fixtures for metadata, trace, terminal/partial state, and the separate transcript tier.
3. Add pure schema/normalization/redaction tests before mounting anything.
4. Review which exact Pi events can support each field against the pinned Pi version.

**Gate:** fixture snapshots prove metadata mode contains no text/content; trace/transcript fixtures contain only fields authorized by their respective policy.

### B. Durable capture lifecycle

1. Implement private capture paths, wrapper control manifests, bounded validation, guarded recovery, and atomic active-to-pending promotion.
2. Add the reviewed Pi emitter and generated minimal extension configuration only when capture is explicitly selected.
3. Add the capture mount to Podman with the same source/path validation as other mounts.
4. Have `runAgent` write final host-owned outcome/completion metadata only after container cleanup is verified.

**Gate:** disabled runs have no capture state or mounts; cleanup uncertainty leaves active data untouched; normal exits produce a validated pending artifact; timeout/abort/client-exit artifacts are marked partial without losing the primary result.

### C. Delivery

1. Implement a host-only client with strict URL/auth/response validation and idempotency.
2. Add an explicit flush operation and result status; no background worker.
3. Delete content only after a verified documented receipt; keep a bounded non-content receipt if required.

**Gate:** fake-server tests cover success, duplicate acknowledgement, malformed receipt, timeout, retry, and restart recovery. Tokens and payload text never appear in argv, diagnostics, or test snapshots.

### D. Content tiers and user experience

1. Enable `metadata` first.
2. Enable `trace` only after prompt/action/failure policy and normalizers are reviewed.
3. Keep `transcript` disabled until its exact schema, consent, retention, redaction limitations, and API access controls are separately approved.
4. Add clear interactive startup/status visibility whenever any content-bearing tier is enabled.

**Gate:** headless capture remains explicit; autonomous runs still cannot discover host Pi resources; unrecognized tool data falls back to non-content metadata.

## Required regression coverage

- Capture configuration rejects invalid tiers, endpoints, credential references, and size limits before all side effects.
- Default `dev` and `run` make no analysis mount, state directory, host API call, or content record.
- Headless capture uses only the approved Pi-pod-owned emitter; it never reads/mounts `~/.pi`, `pi-files`, host settings, or host analytics.
- Podman argv/environment and all diagnostics contain neither endpoint credentials nor trace content.
- Agent-written symlinks, oversized files, excessive files, malformed JSONL, duplicate records, and altered manifests cannot escape the capture root or trigger upload.
- Prompt/action/failure event fixtures preserve ordering and correlation, while metadata mode has no prompt text, tool arguments/results, assistant content, or raw errors.
- Normal exit, nonzero exit, timeout, abort, output-sink failure, and vanished client each produce the correct complete/partial and queue/retention result.
- Container-removal failure prevents reading/uploading/deleting the mounted artifact.
- Fake delivery verifies idempotency, retry persistence, receipt-only deletion, and that delivery failure does not obscure the agent result.
- Pi integration uses fake content and a non-1000 keep-id mapping; it must never use personal transcripts or tokens.

## Completion criteria

This plan is complete only when a caller has deliberately selected a documented capture tier, a completed or partial trace survives container cleanup in a wrapper-owned queue, and a host-only explicit flush can deliver it idempotently to the approved API without exposing delivery secrets to the agent. Full transcripts remain disabled unless separately approved and tested.
