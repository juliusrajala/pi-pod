import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { managedContainerExists } from "../container/lifecycle.ts";
import { validateApiTokenDocument } from "./credentials.ts";
import { hostOpenCodeOpenAiCredential, hostPiCodexCredential } from "./host.ts";
import {
  isAgent,
  profileVersion,
  readAuthDocument,
  readAuthMetadata,
  validProvider,
  type AuthProfile,
} from "./profiles.ts";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
  removeOwnedDirectory,
  writePrivateFile,
} from "../utils/fs.ts";
import { validIdentifier } from "../state/identifiers.ts";

/** Includes native lock/temp siblings as well as the bounded auth.json payload. */
export const maxAuthStageBytes = 1024 * 1024;

export type HostAuthStageSource = "host-pi" | "host-opencode";

type StageMetadata = {
  version: typeof profileVersion;
  agent: AuthProfile["agent"];
  name: string;
  provider: string;
  containerName: string | null;
  ownershipToken: string | null;
  /** The wrapper process that owns this stage; absent on legacy stages. */
  pid?: number;
  /** Absent on existing profile stages for backwards-compatible recovery. */
  source?: "profile" | HostAuthStageSource;
};

export type AuthStage = {
  profile: AuthProfile;
  directory: string;
  agentStateDirectory: string;
  authFile: string;
  reconcile: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/** A host credential is staged transiently and is never written back to its host path. */
export type HostAuthStage = Omit<AuthStage, "profile">;

/** Create a mutable native-agent state directory while retaining wrapper metadata outside it. */
export async function stageAuthProfile(
  profile: AuthProfile,
  options: { containerName?: string; ownershipToken?: string } = {},
): Promise<AuthStage> {
  if ((options.containerName === undefined) !== (options.ownershipToken === undefined)) {
    throw new Error("Auth stage ownership requires both a container name and nonce.");
  }
  const source = await readAuthDocument(profile.authFile);
  validateApiTokenDocument(profile.agent, profile.provider, source);
  const directory = join(await authStageRoot(), crypto.randomUUID());
  await ensurePrivateStateDirectory(directory);
  await writePrivateFile(
    join(directory, "stage.json"),
    `${JSON.stringify(
      {
        version: profileVersion,
        agent: profile.agent,
        name: profile.name,
        provider: profile.provider,
        containerName:
          options.containerName === undefined
            ? null
            : validIdentifier(options.containerName, "Container name"),
        ownershipToken:
          options.ownershipToken === undefined
            ? null
            : validIdentifier(options.ownershipToken, "Container ownership token"),
        pid: process.pid,
        source: "profile",
      } satisfies StageMetadata,
      null,
      2,
    )}\n`,
  );
  // Only this child directory is mounted into the agent. Stage metadata stays
  // outside it, so the agent may create native lock/settings files without
  // gaining control of recovery metadata or persisted profile paths.
  const agentStateDirectory = join(directory, "agent-state");
  await ensurePrivateStateDirectory(agentStateDirectory);
  const authFile = join(agentStateDirectory, "auth.json");
  await writePrivateFile(authFile, source);
  let cleaned = false;

  return {
    profile,
    directory,
    agentStateDirectory,
    authFile,
    // API-token profiles are immutable sources for a run. Native changes are
    // discarded with the stage and are never written back to profile state.
    reconcile: async () => {},
    cleanup: async () => {
      if (cleaned) return;
      await removeStageDirectory(directory);
      cleaned = true;
    },
  };
}

const hostAuthSources: Readonly<
  Record<
    HostAuthStageSource,
    {
      agent: AuthProfile["agent"];
      name: string;
      provider: string;
      credential: () => Promise<string>;
    }
  >
> = {
  "host-pi": {
    agent: "pi",
    name: "host-pi",
    provider: "openai-codex",
    credential: hostPiCodexCredential,
  },
  "host-opencode": {
    agent: "opencode",
    name: "host-opencode",
    provider: "openai",
    credential: hostOpenCodeOpenAiCredential,
  },
};

/** Stage only the selected reviewed host credential for an interactive source-only session. */
export async function stageHostAuth(
  source: HostAuthStageSource,
  options: { containerName?: string; ownershipToken?: string } = {},
): Promise<HostAuthStage> {
  return stageHostAuthSource({ source, ...hostAuthSources[source], ...options });
}

async function stageHostAuthSource(input: {
  agent: AuthProfile["agent"];
  name: string;
  provider: string;
  source: HostAuthStageSource;
  credential: () => Promise<string>;
  containerName?: string;
  ownershipToken?: string;
}): Promise<HostAuthStage> {
  if ((input.containerName === undefined) !== (input.ownershipToken === undefined)) {
    throw new Error("Auth stage ownership requires both a container name and nonce.");
  }
  const source = await input.credential();
  const directory = join(await authStageRoot(), crypto.randomUUID());
  await ensurePrivateStateDirectory(directory);
  await writePrivateFile(
    join(directory, "stage.json"),
    `${JSON.stringify(
      {
        version: profileVersion,
        agent: input.agent,
        name: input.name,
        provider: input.provider,
        containerName:
          input.containerName === undefined
            ? null
            : validIdentifier(input.containerName, "Container name"),
        ownershipToken:
          input.ownershipToken === undefined
            ? null
            : validIdentifier(input.ownershipToken, "Container ownership token"),
        pid: process.pid,
        source: input.source,
      } satisfies StageMetadata,
      null,
      2,
    )}\n`,
  );
  const agentStateDirectory = join(directory, "agent-state");
  await ensurePrivateStateDirectory(agentStateDirectory);
  await writePrivateFile(join(agentStateDirectory, "auth.json"), source);
  let cleaned = false;
  return {
    directory,
    agentStateDirectory,
    authFile: join(agentStateDirectory, "auth.json"),
    // Host credentials are source-only: never propagate agent writes to host state.
    reconcile: async () => {},
    cleanup: async () => {
      if (cleaned) return;
      await removeStageDirectory(directory);
      cleaned = true;
    },
  };
}

/** Remove interrupted source-only host stages only after their containers are gone. */
export async function recoverHostAuthStages(source?: HostAuthStageSource): Promise<void> {
  const root = await authStageRoot();
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    const metadata = await readStageMetadata(join(directory, "stage.json")).catch(() => undefined);
    if (
      (metadata?.source !== "host-pi" && metadata?.source !== "host-opencode") ||
      (source !== undefined && metadata.source !== source)
    )
      continue;
    // A host-auth stage has no shared profile lock. Another dev process may
    // still be between staging and container creation, so a missing container
    // is not enough to establish that this stage is orphaned.
    if (await hostStageIsActive(metadata)) continue;
    if (metadata.pid === undefined) continue;
    await removeStageDirectory(directory, metadata);
  }
}

/**
 * Source-only stages can be shared concurrently. Recovery leaves live and
 * preparing siblings alone, and removes only proven-orphaned stages.
 */
export async function recoverPendingAuthStages(profile: AuthProfile): Promise<void> {
  for (const stage of await matchingStageDirectories(profile)) {
    if (await profileStageIsActive(stage.metadata)) continue;
    await removeStageDirectory(stage.directory, stage.metadata);
  }
}

/** Discard matching interrupted stages only after their managed containers are gone. */
export async function discardPendingAuthStages(profile: AuthProfile): Promise<void> {
  for (const stage of await matchingStageDirectories(profile)) {
    await assertStageContainerStopped(stage);
    await removeStageDirectory(stage.directory, stage.metadata);
  }
}

async function matchingStageDirectories(
  profile: AuthProfile,
): Promise<Array<{ directory: string; metadata: StageMetadata }>> {
  const root = await authStageRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const matches: Array<{ directory: string; metadata: StageMetadata }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    const metadata = await readStageMetadata(join(directory, "stage.json")).catch(() => undefined);
    if (
      metadata?.source === "profile" &&
      metadata.agent === profile.agent &&
      metadata.name === profile.name &&
      metadata.provider === profile.provider
    ) {
      matches.push({ directory, metadata });
    }
  }
  return matches;
}

async function authStageRoot(): Promise<string> {
  const root = join(await privateStateDirectory(), "auth-staging");
  // Canonical/private verification rejects a symlinked descendant rather than
  // following it during recovery.
  return ensurePrivateStateDirectory(root);
}

async function removeStageDirectory(directory: string, expected?: StageMetadata): Promise<void> {
  const root = await authStageRoot();
  const id = basename(directory);
  await removeOwnedDirectory(root, id, async (quarantined) => {
    const actual = await readStageMetadata(join(quarantined, "stage.json"));
    if (expected !== undefined && !sameStageMetadata(actual, expected)) {
      throw new Error("Credential stage metadata changed before guarded removal.");
    }
  });
}

function sameStageMetadata(left: StageMetadata, right: StageMetadata): boolean {
  return (
    left.version === right.version &&
    left.agent === right.agent &&
    left.name === right.name &&
    left.provider === right.provider &&
    left.containerName === right.containerName &&
    left.ownershipToken === right.ownershipToken &&
    left.pid === right.pid &&
    left.source === right.source
  );
}

async function readStageMetadata(path: string): Promise<StageMetadata> {
  const value = await readAuthMetadata(path, "auth stage metadata");
  if (
    !isRecord(value) ||
    value.version !== profileVersion ||
    !isAgent(value.agent) ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string" ||
    (value.containerName !== null && typeof value.containerName !== "string") ||
    (value.ownershipToken !== null && typeof value.ownershipToken !== "string") ||
    (value.containerName === null) !== (value.ownershipToken === null) ||
    (value.pid !== undefined &&
      (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)) ||
    (value.source !== "profile" && value.source !== "host-pi" && value.source !== "host-opencode")
  ) {
    throw new Error(`Invalid auth stage metadata: ${path}`);
  }
  validIdentifier(value.name, "Auth profile");
  validProvider(value.provider);
  if (typeof value.containerName === "string")
    validIdentifier(value.containerName, "Container name");
  if (typeof value.ownershipToken === "string")
    validIdentifier(value.ownershipToken, "Container ownership token");
  return {
    version: profileVersion,
    agent: value.agent,
    name: value.name,
    provider: value.provider,
    containerName: value.containerName,
    ownershipToken: value.ownershipToken,
    ...(value.pid === undefined ? {} : { pid: value.pid }),
    source: value.source,
  };
}

async function hostStageIsActive(metadata: StageMetadata): Promise<boolean> {
  return profileStageIsActive(metadata);
}

async function profileStageIsActive(metadata: StageMetadata): Promise<boolean> {
  // Check the owner first: this covers the interval before Podman has created
  // the named container and avoids asking recovery to race startup.
  if (metadata.pid !== undefined && processExists(metadata.pid)) return true;
  return (
    metadata.containerName !== null &&
    metadata.ownershipToken !== null &&
    (await managedContainerExists(metadata.containerName, metadata.ownershipToken))
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

async function assertStageContainerStopped(stage: {
  directory: string;
  metadata: StageMetadata;
}): Promise<void> {
  const name = stage.metadata.containerName;
  if (
    name !== null &&
    stage.metadata.ownershipToken !== null &&
    (await managedContainerExists(name, stage.metadata.ownershipToken))
  ) {
    throw new Error(
      `Credential stage ${stage.directory} is still mounted by container ${name}; stop it before recovery.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
