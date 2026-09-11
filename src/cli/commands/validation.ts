/**
 * Core 0.0.19 collects variadic positionals and raw `--` arguments but does
 * not reject them automatically. These action preconditions run before any
 * workspace, credential, or Podman operation; they do not parse argv.
 */
export function requireNoExtraArguments(values: readonly string[], command: string): void {
  if (values.length > 0) throw new Error(`${command} does not accept extra positional arguments.`);
}

export function requireNoAgentArguments(values: readonly string[], command: string): void {
  if (values.length > 0) throw new Error(`${command} does not accept agent arguments after --.`);
}
