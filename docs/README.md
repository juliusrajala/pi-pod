# pi-pod documentation

New to pi-pod? The [quick start](../README.md#quick-start) walks through your first session and task.

## Get it running

| Goal                                                             | Guide                                       |
| ---------------------------------------------------------------- | ------------------------------------------- |
| Install from source, use a release bundle, or check requirements | [Installation](installation.md)             |
| Work interactively, run a task, and review the results           | [Usage](usage.md)                           |
| Sign in, supply an API key, or recover an interrupted profile    | [Authentication](authentication.md)         |
| Fix a launch or workspace problem                                | [Troubleshooting](usage.md#troubleshooting) |

## Customize your workflow

- [Supported agents](agents.md) — Pi/OpenCode versions, authentication support, and interactive Pi extensions.
- [Model preferences](configuration.md) — choose models, Pi thinking levels, and OpenCode variants.
- [Library API](library.md) — run agents from a trusted Bun application and handle results or cancellation.

## Understand and contribute

- [Security boundary](security.md) — what is isolated, what is shared, and the limits of containment.
- [Architecture and lifecycle](architecture.md) — code navigation, startup, cleanup, and ownership.
- [Development](development.md) — runtime setup, tests, release builds, and adding an agent.
- [Plans](plans/README.md) — outstanding proposals and archived decisions, separate from supported behavior.
- Adversarial reviews: [initial implementation](reviews/01-adversarial-review.md) and [current-state review and remediation checkpoint](reviews/02-current-state-adversarial-review.md).
