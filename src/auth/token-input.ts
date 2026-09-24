const maxTokenBytes = 16 * 1024;

export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** Minimal structural view of a controlling-terminal standard input. */
export type TerminalStdin = {
  readonly isTTY: boolean | undefined;
  readonly isRaw: boolean | undefined;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
};

/** Signal delivery seam; tests prove restoration happens before the re-raise. */
export type TerminalSignalOwner = {
  addListener(signal: TerminalSignal, listener: () => void): void;
  removeListener(signal: TerminalSignal, listener: () => void): void;
  raise(signal: TerminalSignal): void;
};

const processSignals: TerminalSignalOwner = {
  addListener: (signal, listener) => process.once(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  raise: (signal) => process.kill(process.pid, signal),
};

/** Read one bounded token without echoing it on the controlling terminal. */
export async function readApiToken(prompt = "API token: "): Promise<string> {
  return readApiTokenFrom(process.stdin, process.stderr, processSignals, prompt);
}

/** Explicit-dependency core for pseudo-terminal and signal regressions. */
export async function readApiTokenFrom(
  stdin: TerminalStdin,
  stderr: { write(text: string): unknown },
  signals: TerminalSignalOwner,
  prompt = "API token: ",
): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("API-token profile creation requires an interactive controlling terminal.");
  }
  stderr.write(prompt);
  const wasRaw = stdin.isRaw === true;
  const restore = () => {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  };
  // Raw-mode input bypasses normal Ctrl-C handling. Restore synchronously for
  // external termination signals before re-raising the original signal.
  const signalNames: readonly TerminalSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signalNames.map((signal) => {
    const listener = () => {
      restore();
      signals.raise(signal);
    };
    signals.addListener(signal, listener);
    return { signal, listener };
  });
  const bytes: number[] = [];
  try {
    stdin.setRawMode(true);
    stdin.resume();
    for await (const chunk of stdin) {
      const input = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      for (const byte of input) {
        if (byte === 3) throw new DOMException("Token input aborted.", "AbortError");
        if (byte === 10 || byte === 13) {
          stderr.write("\n");
          const token = new TextDecoder().decode(Uint8Array.from(bytes));
          if (token.length === 0) throw new Error("API token must not be empty.");
          return token;
        }
        if (byte === 8 || byte === 127) {
          bytes.pop();
          continue;
        }
        if (bytes.length >= maxTokenBytes) throw new Error("API token exceeds 16384 bytes.");
        bytes.push(byte);
      }
    }
    throw new Error("Token input ended before a token was provided.");
  } finally {
    for (const { signal, listener } of listeners) signals.removeListener(signal, listener);
    restore();
  }
}
