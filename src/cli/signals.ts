export type Interrupt = {
  signal: AbortSignal;
  dispose: () => void;
};

/** Convert the first terminal interrupt into cancellation; a second exits. */
export function interruptSignal(): Interrupt {
  const controller = new AbortController();
  let interrupts = 0;
  const interrupt = () => {
    interrupts += 1;
    if (interrupts === 1) controller.abort(new Error("Interrupted."));
    else process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    },
  };
}
