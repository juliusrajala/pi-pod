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
  } = {},
): Promise<string> {
  const proc = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command[0] ?? "Command"} failed (${exitCode}): ${stderr.trim() || "no error output"}`,
    );
  }
  return stdout;
}
