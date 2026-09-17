# Plans

This directory contains outstanding work, not the current product manual. Use the [maintained documentation](../docs/README.md) for supported behavior and commands.

## Current work

| Plan                                                                                | Status                             | Remaining scope                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [03 — Analysis traces and delivery](03-analysis-trace-delivery.md)                  | Deferred proposal; not implemented | Capture/privacy policy, durable opt-in traces, host-only delivery.                                                 |
| [04 — Agent configuration](04-readability-agent-configuration-and-documentation.md) | Partially implemented              | D2 resource catalog/selection, an explicitly selected third-agent spike, and host-stage concurrency investigation. |
| [05 — Domain layout and navigation](05-domain-layout-and-navigation.md)             | Implementation in progress         | Complete domain migration, uniform formatting, colocated tests, navigation docs, and review.                       |
| [07 — Host-auth development concurrency](07-host-auth-dev-concurrency.md)           | Verification/closeout              | Prove and document concurrent source-only host-auth staging for interactive development.                           |

The [Plan 04 JSON example](04-agent-configuration.example.json) illustrates the full resource-selection design. It includes unsupported fields and is **not** a ready-to-use configuration. Working examples are linked from [configuration documentation](../docs/configuration.md).

## Archived decisions

Completed or superseded plans are kept under `archive/` for rationale and security history, not as another backlog:

- [01 — Initial wrapper design](archive/01-agent-container-wrapper.md).
- [02 — Earlier readability and autonomous validation](archive/02-readability-and-autonomous-validation.md).
- [04 — Original architecture/configuration design](archive/04-readability-and-autonomous-validation.md). Its outstanding work is summarized in active Plan 04; its intermediate layout is superseded by Plan 05.
- [06 — Compiled CLI and platform distribution](archive/06-compiled-cli-distribution.md). Linux x64 release bundle support is implemented; arm64 and hosted release channels remain deferred.

The [adversarial review](../reviews/01-adversarial-review.md) remains intact. Archiving a plan does not mean all historical security limits or manual validation requirements have disappeared. Current guarantees and limitations belong in [security documentation](../docs/security.md); provider-specific manual validation belongs in [authentication documentation](../docs/authentication.md).

When work completes, update maintained documentation and this index, then archive the implementation plan. Keep unresolved decisions visible without making readers search completed task lists. Preserve plan numbering and do not describe in-progress code as reviewed or released.
