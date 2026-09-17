# Agent configuration: remaining work

**Status: partially implemented; remaining work requires the decisions below.**

The original structure review, vocabulary, model-preference schema, and checkpoints are preserved in the [archived design](archive/04-readability-agent-configuration-and-documentation.md). Do not treat that document's completed checkpoints as new tasks.

## What is no longer part of this plan

- Current model preferences, `dev` configuration auto-loading, explicit `--config`, and `--no-config` are documented in [configuration](../docs/configuration.md).
- Current agent capabilities and contributor guidance live in [agents](../docs/agents.md) and [development](../docs/development.md).
- The remaining domain-layout, formatting, test-location, and navigation work belongs to [Plan 05](05-domain-layout-and-navigation.md). Its implementation and review are not declared complete by this cleanup.
- Opt-in analysis capture and delivery remain separate [Plan 03](03-analysis-trace-delivery.md) work.

Do not reimplement these features or revive the original intermediate file layout. Preserve the existing runtime defaults while completing the remaining items.

## D2 — Explicit resource selection

Resource selection is not implemented. The [complete design example](04-agent-configuration.example.json) remains a design fixture, not a usable configuration file: its resource fields must continue to be rejected until supported.

### Agreed shape and semantics

Resources occupy a separate section from preferences within each agent's `dev` or `run` configuration:

```json
{
  "resources": {
    "extensions": [],
    "skills": []
  }
}
```

Pi uses `extensions` and `skills`. OpenCode uses `plugins` and `skills` where verified against the pinned native version. Use plain arrays; no `allow` wrapper.

| Property       | Meaning                                                |
| -------------- | ------------------------------------------------------ |
| Omitted        | Preserve the existing default for that agent and mode. |
| Empty array    | Disable that optional resource category.               |
| Nonempty array | Load only the named resources in that category.        |

These rules apply independently to each property. Pi currently loads approved interactive host extensions by default; omission is not equivalent to disabling them. Mandatory bundled provider/auth integrations are not optional user plugins.

### Decisions required before implementation

1. **Trusted local catalog:** where are resource sources declared, who authorizes them, and how do names such as `pi-files/auto-model` resolve? That identifier is illustrative, not a supported lookup mechanism.
2. **Identity and selection:** specify unique identifiers, duplicate/ambiguous names, missing resources, exact file/package selection, and source/version identity.
3. **Native loading:** verify each agent/category/mode can load exactly the selection while disabling other discovery. Do not claim support where native controls cannot enforce the contract.
4. **Mount boundaries:** define the necessary read-only code/dependency mounts and container-local generated settings without importing broader host state.
5. **Autonomous sources:** require explicit trusted-caller resource selection. Never discover personal packages, extensions, settings, skills, sessions, analytics, or credentials for headless use.

Allowlisting does not install, fetch, or automatically trust packages. Resource identifiers must not silently become arbitrary host paths or host-executable configuration. `run` never inherits `dev` selections.

### Implementation and acceptance

- Implement resource parsing/resolution separately from model preferences; preserve their existing precedence and loading behavior.
- Validate unsupported categories, unknown names, and incompatible modes before launch; never silently ignore them, including empty arrays for unimplemented categories.
- Resolve only the selected agent/mode; unselected sections must not trigger filesystem reads, mounts, or installs.
- Test omitted/empty/nonempty distinctions, exact selection, missing/ambiguous names, read-only mounts, disabled native discovery, no host writes, and preservation of bundled auth integrations.
- Add explicit headless fixtures proving no personal resource discovery.
- Promote examples to supported documentation only when every illustrated field is implemented and verified.

## E — Additional-agent compatibility spike

No third agent is selected or promised. Choose one based on an explicit user requirement, then:

1. Pin a version and verify executable paths, runtime dependencies, architecture, licensing/distribution, and update behavior.
2. Verify interactive/headless commands, prompt transport, unattended behavior, cancellation, and exit semantics.
3. Prove operation under the existing rootless, read-only, capability, mount, and resource restrictions. Do not weaken the shared boundary to claim support.
4. Specify provider IDs, native credential schemas/state paths, explicit-token support, and optional profile/host-auth capabilities. Unsupported login methods remain documented limitations.
5. Audit project settings/plugin discovery and native resource controls; document differences rather than claiming identical agent behavior.
6. Add shared contract and agent-specific compatibility tests and documentation.

Keep the shared image unless the spike demonstrates a material dependency, size, or update-cadence reason to split it. Per-agent images need explicit mapping and override semantics, not automatic pulls/builds or runtime installers. Implementation follows a separate review of the spike results.

## Separate lifecycle follow-up

Before generalizing host-stage recovery, investigate concurrent live, preparing, and orphaned runs. The prior review identified a recovery scan that refuses a stage with a present container and a startup interval before the container exists. Establish the behavior with fixtures against the current implementation; this is not a claim that a subsequent implementation still has the same issue.

Keep any correctness fix separate from structural moves. Never resolve concurrency by deleting active stages, inferring container absence from a dead wrapper alone, or weakening recovery checks.

## Validation

Use the pinned runtime and the repository's current documented formatting, test, and typecheck commands; run `git diff --check`. Run Podman/systemd integrations only when their environment is available. Tests use isolated synthetic fixtures, not personal credentials or paid model requests.

For autonomous subscription profiles that are actually needed, user-assisted login/reuse/refresh validation remains a separate manual gate; see [authentication](../docs/authentication.md). Token-based automation does not depend on completing that gate. Do not expand container networking to make an unsupported OAuth callback work.
