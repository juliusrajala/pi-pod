import { agentNames } from "../agents/registry.ts";
import type { AgentPreferences } from "../config/types.ts";
import type { AgentName } from "../agents/registry.ts";

export const agents = agentNames;
export type { AgentName };

export const workspaceModes = ["bind", "clone"] as const;
export type WorkspaceMode = (typeof workspaceModes)[number];

export type RunMode = "interactive" | "headless";

/** Backpressured output sinks for trusted library callers. Omit to inherit the terminal. */
export type OutputSinks = {
  stdout?: WritableStream<Uint8Array>;
  stderr?: WritableStream<Uint8Array>;
};

export type ResourceLimits = {
  memory: string;
  cpus: number;
  pids: number;
  workspaceBytes: number;
  temporaryBytes: number;
};

/** Caller-owned bind workspaces are never eligible for retained-run deletion. */
export type BindWorkspace = {
  mode: "bind";
  path: string;
  owned: false;
  sourcePath: string;
};

/** Only pi-pod-created clone workspaces carry retained-run ownership data. */
export type CloneWorkspace = {
  mode: "clone";
  path: string;
  owned: true;
  runId: string;
  sourcePath: string;
  baseRevision: string;
};

export type PreparedWorkspace = BindWorkspace | CloneWorkspace;

/**
 * Trusted host-caller options. Do not expose this type directly to an agent or
 * an untrusted HTTP request without validating its fields against a policy.
 */
export type RunAgentOptions = {
  agent?: AgentName;
  mode: RunMode;
  workspace: string;
  workspaceMode?: WorkspaceMode;
  prompt?: string;
  /** Typed preferences supplied by a trusted caller; the library never reads a config file. */
  preferences?: AgentPreferences;
  agentArgs?: readonly string[];
  environment?: readonly string[];
  authProfile?: string | "none";
  image?: string;
  limits?: Partial<ResourceLimits>;
  timeoutMs?: number;
  network?: "pasta" | "none";
  relabelWorkspace?: boolean;
  signal?: AbortSignal;
  onDiagnostic?: (message: string) => void;
  output?: OutputSinks;
};

export type OutputOutcome = {
  mode: "inherited" | "streamed";
  error?: string;
};

export type AuthOutcome = {
  /** `host` is an interactive source-only stage; it never writes to host agent state. */
  source: "none" | "profile" | "host";
  reconciliation: "not-used" | "persisted" | "retained";
  lock: "not-used" | "released" | "retained" | "release-failed";
  error?: string;
};

export type RunResult = {
  agent: AgentName;
  containerName: string;
  exitCode: number;
  termination: "exited" | "timeout" | "aborted" | "workspace-limit" | "auth-limit";
  workspace: PreparedWorkspace;
  cleanup: {
    containerRemoved: boolean;
    /** Only owned clones have a launch reservation. */
    reservation: "not-owned" | "released" | "unreleased";
    error?: string;
  };
  /** Credential persistence and lock disposition after container cleanup. */
  auth: AuthOutcome;
  output: OutputOutcome;
};

export type LoginOptions = {
  agent: AgentName;
  provider: string;
  profile?: string;
  image?: string;
  signal?: AbortSignal;
  onDiagnostic?: (message: string) => void;
  output?: OutputSinks;
};

export type LoginResult = {
  agent: AgentName;
  provider: string;
  profile: string;
};
