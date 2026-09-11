import type { OutputSinks } from "../types.ts";
import { hostToolEnvironment } from "../utils.ts";

const pollIntervalMs = 50;
const cleanupTimeoutMs = 15_000;
const commandTimeoutMs = 7_000;

export type ContainerCleanup = {
  removed: boolean;
  error?: string;
};

export type ContainerExecution = {
  exitCode: number;
  aborted: boolean;
  cleanup: ContainerCleanup;
  outputError?: string;
};

/**
 * Own one attached `podman run` invocation from spawn through verified removal.
 * A stopped Podman client is not evidence that its container disappeared, so
 * callers must use `cleanup.removed` before touching mounted credentials.
 */
export async function runPodmanContainer(input: {
  args: readonly string[];
  name: string;
  environment: Record<string, string>;
  signal?: AbortSignal;
  output?: OutputSinks;
  onStarted?: () => void;
  onDiagnostic?: (message: string) => void;
}): Promise<ContainerExecution> {
  input.signal?.throwIfAborted();
  const usePipes = input.output !== undefined;
  const process = Bun.spawn(["podman", ...input.args], {
    stdin: "inherit",
    stdout: usePipes ? "pipe" : "inherit",
    stderr: usePipes ? "pipe" : "inherit",
    env: input.environment,
  });
  let outputError: string | undefined;
  const outputDone = usePipes
    ? Promise.all([
      pipeOutput(process.stdout as ReadableStream<Uint8Array>, input.output?.stdout ?? terminalSink(Bun.stdout)),
      pipeOutput(process.stderr as ReadableStream<Uint8Array>, input.output?.stderr ?? terminalSink(Bun.stderr)),
    ]).catch((error) => {
      outputError = errorMessage(error);
      // A failed sink must not leave an attached client blocked on a full pipe.
      try {
        process.kill("SIGTERM");
      } catch {
        // The client may have exited between pipe failure and this signal.
      }
    })
    : Promise.resolve();

  let clientExited = false;
  void process.exited.then(() => { clientExited = true; });
  let abortCleanup: Promise<ContainerCleanup> | undefined;
  const abort = () => {
    if (abortCleanup !== undefined) return;
    abortCleanup = terminateAfterAbort({ process, name: input.name, clientExited: () => clientExited });
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  try {
    input.onStarted?.();
    const exitCode = await process.exited;
    await outputDone;
    if (abortCleanup !== undefined) {
      const cleanup = await abortCleanup;
      if (!cleanup.removed) input.onDiagnostic?.(cleanup.error ?? `Could not verify removal of container ${input.name}.`);
      return { exitCode, aborted: true, cleanup, ...(outputError === undefined ? {} : { outputError }) };
    }

    const cleanup = await removeLeftoverContainer(input.name);
    if (!cleanup.removed) input.onDiagnostic?.(cleanup.error ?? `Could not verify removal of container ${input.name}.`);
    return { exitCode, aborted: false, cleanup, ...(outputError === undefined ? {} : { outputError }) };
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}

/** Used by credential recovery before it reads a stage a container may write. */
export async function managedContainerExists(name: string): Promise<boolean> {
  const result = await podmanCommand(["container", "exists", name]);
  if (result === 0) return true;
  if (result === 1) return false;
  throw new Error(`Could not determine whether container ${name} exists (podman exited ${result}).`);
}

async function terminateAfterAbort(input: {
  process: ReturnType<typeof Bun.spawn>;
  name: string;
  clientExited: () => boolean;
}): Promise<ContainerCleanup> {
  try {
    // Stop the client as well as the container. A client that is still starting
    // may otherwise create a container after an early stop command reports it
    // missing. Keep polling until that client exits, then check one final time.
    input.process.kill("SIGTERM");
    const deadline = Date.now() + cleanupTimeoutMs;
    while (Date.now() < deadline) {
      if (await managedContainerExists(input.name)) return stopAndRemove(input.name, deadline);
      if (input.clientExited()) {
        await Bun.sleep(pollIntervalMs);
        return removeLeftoverContainer(input.name, deadline);
      }
      await Bun.sleep(pollIntervalMs);
    }
    return { removed: false, error: `Timed out waiting to verify removal of container ${input.name}.` };
  } catch (error) {
    return { removed: false, error: errorMessage(error) };
  }
}

async function removeLeftoverContainer(name: string, deadline = Date.now() + cleanupTimeoutMs): Promise<ContainerCleanup> {
  try {
    if (!(await managedContainerExists(name))) return { removed: true };
    return stopAndRemove(name, deadline);
  } catch (error) {
    return { removed: false, error: errorMessage(error) };
  }
}

async function stopAndRemove(name: string, deadline: number): Promise<ContainerCleanup> {
  try {
    await podmanCommand(["stop", "--time", "5", name], deadline);
    if (await managedContainerExists(name)) await podmanCommand(["kill", name], deadline);
    if (await managedContainerExists(name)) await podmanCommand(["rm", "--force", name], deadline);
    return await waitForRemoval(name, deadline);
  } catch (error) {
    return { removed: false, error: errorMessage(error) };
  }
}

async function waitForRemoval(name: string, deadline: number): Promise<ContainerCleanup> {
  while (Date.now() < deadline) {
    if (!(await managedContainerExists(name))) return { removed: true };
    await Bun.sleep(pollIntervalMs);
  }
  return { removed: false, error: `Timed out waiting for Podman to remove container ${name}.` };
}

async function podmanCommand(args: readonly string[], deadline = Date.now() + commandTimeoutMs): Promise<number> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Timed out before podman ${args[0]} could run.`);
  const process = Bun.spawn(["podman", ...args], {
    stdout: "ignore",
    stderr: "ignore",
    env: hostToolEnvironment(),
  });
  const result = await Promise.race([
    process.exited,
    Bun.sleep(Math.min(remainingMs, commandTimeoutMs)).then(() => undefined),
  ]);
  if (result !== undefined) return result;
  process.kill("SIGKILL");
  throw new Error(`Timed out running podman ${args[0]}.`);
}

function terminalSink(file: Bun.BunFile): WritableStream<Uint8Array> {
  return new WritableStream({
    write: async (chunk) => {
      await Bun.write(file, chunk);
    },
  });
}

async function pipeOutput(source: ReadableStream<Uint8Array>, destination: WritableStream<Uint8Array>): Promise<void> {
  await source.pipeTo(destination, { preventClose: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
