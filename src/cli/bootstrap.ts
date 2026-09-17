import { realpathSync } from "node:fs";

let trustedExecutablePath: string | undefined;
let compiledRuntime = false;

/**
 * The shell launcher starts Bun in the trusted package directory so a caller
 * workspace cannot preload code through bunfig.toml. Restore the real process
 * context before command actions resolve workspace paths or state locations.
 */
export function restoreCallerEnvironment(): void {
  const callerCwd = Bun.env.PI_POD_CALLER_CWD;
  const hostHome = Bun.env.PI_POD_HOST_HOME;
  const launcher = Bun.env.PI_POD_LAUNCHER;
  delete Bun.env.PI_POD_CALLER_CWD;
  delete Bun.env.PI_POD_HOST_HOME;
  delete Bun.env.PI_POD_LAUNCHER;
  if (hostHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = hostHome;
  if (callerCwd !== undefined) process.chdir(callerCwd);
  compiledRuntime = false;
  trustedExecutablePath = launcher === undefined ? undefined : requireAbsolutePath(launcher);
}

/** Configure startup for the standalone compiled host controller. */
export function configureCompiledEnvironment(): void {
  // These are source-launcher handoff variables. Never let a caller-provided
  // value influence a compiled executable's context or delegated re-exec.
  delete Bun.env.PI_POD_CALLER_CWD;
  delete Bun.env.PI_POD_HOST_HOME;
  delete Bun.env.PI_POD_LAUNCHER;
  compiledRuntime = true;
  trustedExecutablePath = requireAbsolutePath(realpathSync(process.execPath));
}

/** Whether this process is the standalone release controller. */
export function isCompiledRuntime(): boolean {
  return compiledRuntime;
}

/** Return the executable selected by trusted startup, never PATH discovery. */
export function getTrustedExecutablePath(): string {
  if (trustedExecutablePath === undefined) {
    throw new Error("pi-pod could not determine its trusted executable path.");
  }
  return trustedExecutablePath;
}

function requireAbsolutePath(path: string): string {
  if (!path.startsWith("/")) throw new Error("pi-pod trusted executable path must be absolute.");
  return path;
}
