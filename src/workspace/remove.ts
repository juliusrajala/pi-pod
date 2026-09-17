import { commandOutput, hostToolEnvironment } from "../utils/process.ts";
import { validIdentifier } from "../state/identifiers.ts";
import { removeRun } from "./runs.ts";

/** Public guarded retained-clone deletion; bind workspaces are never removable. */
export async function removeAgentRun(runId: string): Promise<void> {
  validIdentifier(runId, "Run ID");
  const active = await commandOutput(
    ["podman", "ps", "--all", "--quiet", "--filter", `label=io.pi-pod.run-id=${runId}`],
    { env: hostToolEnvironment() },
  );
  if (active.trim().length > 0) {
    throw new Error(`Run ${runId} still has a container. Stop it before removing its workspace.`);
  }
  await removeRun(runId);
}
