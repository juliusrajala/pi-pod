const maxTokenBytes = 16 * 1024;

/** Read one bounded token without echoing it on the controlling terminal. */
export async function readApiToken(prompt = "API token: "): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("API-token profile creation requires an interactive controlling terminal.");
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  const restore = () => {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  };
  // Raw-mode input bypasses normal Ctrl-C handling. Restore synchronously for
  // external termination signals before re-raising the original signal.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const signalListeners = signals.map((signal) => {
    const listener = () => {
      restore();
      process.kill(process.pid, signal);
    };
    process.once(signal, listener);
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
          process.stderr.write("\n");
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
    for (const { signal, listener } of signalListeners) process.removeListener(signal, listener);
    restore();
  }
}
