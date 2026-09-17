# Host-auth development concurrency

**Status: targeted bug fix and documentation closeout.** Per-run staging exists, but current host-stage recovery rejects a new session when it sees an active sibling container; this plan makes concurrent interactive use an explicit, tested guarantee.

## Contract

`pi-pod dev` with `--auth host` (the interactive default) may run multiple containers side by side using the same selected host credential.

For each invocation, pi-pod must:

1. Read and validate only the selected provider credential file.
2. Copy it to a fresh private, per-container staging directory.
3. Mount only that private agent-state directory into that container.
4. Never mount the host agent/secrets directory and never copy container changes back to it.

The staging directory is writable only because native agents may create lock/state files. It is unique per run, so host-auth sessions require **no shared profile lock**. Named pi-pod profiles remain serialized: they can be refreshed and persisted, unlike source-only host credentials.

Host auth remains `dev`-only. It is never available to headless `run` or library-autonomous callers.

## Acceptance

- Add a fixture-based test launching two host-auth dev preparations for the same agent/provider and asserting distinct stage directories, distinct Podman mount sources, and no profile-lock acquisition.
- Assert neither mount source is the host credential directory; the only host read is the approved credential file.
- Change recovery to skip an active sibling stage rather than treating it as an error, while deleting only proven-orphaned stages. It must also preserve a live sibling in the pre-container startup interval; container absence alone is not proof it is orphaned.
- Assert cleanup deletes each private stage only after its own container is verified gone; recovery must not delete or block on an active sibling stage.
- Document that concurrent host-auth dev sessions are supported, while concurrent named-profile sessions are intentionally rejected.
- Preserve source-only behavior: no real credentials in tests, no host write-back, no broad state mount, and no relaxation of mount/path validation.

Fix only the per-run staging/recovery path and add the regression test. Do not solve it by mounting host state, sharing a writable stage, removing profile locks, or deleting stages based only on a missing container.
