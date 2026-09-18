/** Return only the host variables required by a wrapper-owned host command. */
export function hostToolEnvironment(extra: readonly string[] = []): Record<string, string> {
  const names = new Set([
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "CONTAINERS_CONF",
    "CONTAINERS_STORAGE_CONF",
    "CONTAINERS_REGISTRIES_CONF",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    ...extra,
  ]);
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = Bun.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function commandOutput(
  command: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    maxOutputBytes?: number;
  } = {},
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new Error("Command output limit must be a non-negative safe integer.");
  }
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedStream(proc.stdout, maxOutputBytes, command[0] ?? "Command"),
      readBoundedStream(proc.stderr, maxOutputBytes, command[0] ?? "Command"),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${command[0] ?? "Command"} failed (${exitCode}): ${stderr.trim() || "no error output"}`,
      );
    }
    return stdout;
  } catch (error) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited while output was being bounded.
    }
    await proc.exited.catch(() => undefined);
    throw error;
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  command: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`${command} output exceeds ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}
