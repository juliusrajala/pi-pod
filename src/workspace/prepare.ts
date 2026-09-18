import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedWorkspace, WorkspaceMode } from "../execution/types.ts";
import { canonicalPath, realDirectory, stateDirectory } from "../utils/fs.ts";
import { isInside, validIdentifier } from "../state/identifiers.ts";
import { prepareClone } from "./git.ts";

/**
 * Policy entry point for workspace preparation. Bind paths remain caller-owned;
 * clone paths are wrapper-owned retained runs.
 */
export async function prepareWorkspace(input: {
  path: string;
  mode: WorkspaceMode;
  runId?: string;
  /** Internal lifecycle reservation; omitted by standalone workspace callers. */
  containerName?: string;
  ownershipToken?: string;
  signal?: AbortSignal;
}): Promise<PreparedWorkspace> {
  const sourcePath = await realDirectory(input.path, "Workspace");
  await assertWorkspaceDoesNotOverlapState(sourcePath);
  if (input.mode === "bind") {
    await assertBindableWorkspace(sourcePath);
    return { mode: "bind", path: sourcePath, owned: false, sourcePath };
  }
  const runId = validIdentifier(input.runId ?? crypto.randomUUID(), "Run ID");
  return prepareClone({
    sourcePath,
    runId,
    signal: input.signal,
    containerName: input.containerName,
    ownershipToken: input.ownershipToken,
  });
}

async function assertWorkspaceDoesNotOverlapState(workspace: string): Promise<void> {
  // Do not create state while rejecting an overlapping workspace.
  const canonicalState = await canonicalPath(stateDirectory());
  if (isInside(workspace, canonicalState) || isInside(canonicalState, workspace)) {
    throw new Error(
      "Workspace overlaps pi-pod state. Choose an XDG_STATE_HOME outside the mounted workspace.",
    );
  }
}

async function assertBindableWorkspace(path: string): Promise<void> {
  const dotGit = join(path, ".git");
  const metadata = await lstat(dotGit).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  if (metadata.isSymbolicLink() || metadata.isFile()) {
    throw new Error(
      "Bind workspaces cannot use external Git metadata (linked worktrees are unsupported). Mount a regular checkout or use clone mode.",
    );
  }
  if (!metadata.isDirectory()) throw new Error("Workspace .git must be a directory when present.");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
