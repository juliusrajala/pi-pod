/**
 * The shell launcher starts Bun in the trusted package directory so a caller
 * workspace cannot preload code through bunfig.toml. Restore the real process
 * context before command actions resolve workspace paths or state locations.
 */
export function restoreCallerEnvironment(): void {
  const callerCwd = Bun.env.PI_POD_CALLER_CWD;
  const hostHome = Bun.env.PI_POD_HOST_HOME;
  delete Bun.env.PI_POD_CALLER_CWD;
  delete Bun.env.PI_POD_HOST_HOME;
  if (hostHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = hostHome;
  if (callerCwd !== undefined) process.chdir(callerCwd);
}
