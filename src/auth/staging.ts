import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { managedContainerExists } from "../container/lifecycle.ts";
import { normalizedCredentialDocument, validateCredentialDocument } from "./credentials.ts";
import { hostOpenCodeOpenAiCredential, hostPiCodexCredential } from "./host.ts";
import {
  isAgent,
  isMissing,
  profileVersion,
  readAuthDocument,
  readAuthMetadata,
  validProvider,
  type AuthProfile,
} from "./profiles.ts";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
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
  options: { containerName?: string } = {},
): Promise<AuthStage> {
  const source = await readAuthDocument(profile.authFile);
  validateCredentialDocument(profile.agent, profile.provider, source);
  const directory = join(await privateStateDirectory(), "auth-staging", crypto.randomUUID());
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
  let reconciled = false;
  let cleaned = false;

  return {
    profile,
    directory,
    agentStateDirectory,
    authFile,
    reconcile: async () => {
      if (reconciled) return;
      const updated = await readAuthDocument(authFile);
      validateCredentialDocument(profile.agent, profile.provider, updated, true);
      await writePrivateFile(
        profile.authFile,
        normalizedCredentialDocument(profile.agent, profile.provider, updated),
      );
      reconciled = true;
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
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
  options: { containerName?: string } = {},
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
}): Promise<HostAuthStage> {
  const source = await input.credential();
  const directory = join(await privateStateDirectory(), "auth-staging", crypto.randomUUID());
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
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Remove interrupted source-only host stages only after their containers are gone. */
export async function recoverHostAuthStages(source?: HostAuthStageSource): Promise<void> {
  const root = join(await privateStateDirectory(), "auth-staging");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (isMissing(error)) return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    const metadata = await readStageMetadata(join(directory, "stage.json")).catch(() => undefined);
    if (
      (metadata?.source !== "host-pi" && metadata?.source !== "host-opencode") ||
      (source !== undefined && metadata.source !== source)
    )
      continue;
    await assertStageContainerStopped({ directory, metadata });
    await rm(directory, { recursive: true, force: true });
  }
}

export async function recoverPendingAuthStages(profile: AuthProfile): Promise<void> {
  for (const stage of await matchingStageDirectories(profile)) {
    await assertStageContainerStopped(stage);
    const authFile = join(stage.directory, "agent-state", "auth.json");
    const updated = await readAuthDocument(authFile);
    validateCredentialDocument(profile.agent, profile.provider, updated, true);
    await writePrivateFile(
      profile.authFile,
      normalizedCredentialDocument(profile.agent, profile.provider, updated),
    );
    await rm(stage.directory, { recursive: true, force: true });
  }
}

/** Discard matching interrupted stages only after their managed containers are gone. */
export async function discardPendingAuthStages(profile: AuthProfile): Promise<void> {
  for (const stage of await matchingStageDirectories(profile)) {
    await assertStageContainerStopped(stage);
    await rm(stage.directory, { recursive: true, force: true });
  }
}

async function matchingStageDirectories(
  profile: AuthProfile,
): Promise<Array<{ directory: string; metadata: StageMetadata }>> {
  const root = join(await privateStateDirectory(), "auth-staging");
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (isMissing(error)) return [];
    throw error;
  });
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

async function readStageMetadata(path: string): Promise<StageMetadata> {
  const value = await readAuthMetadata(path, "auth stage metadata");
  if (
    !isRecord(value) ||
    value.version !== profileVersion ||
    !isAgent(value.agent) ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string" ||
    (value.containerName !== null && typeof value.containerName !== "string") ||
    (value.source !== undefined && value.source !== "host-pi" && value.source !== "host-opencode")
  ) {
    throw new Error(`Invalid auth stage metadata: ${path}`);
  }
  validIdentifier(value.name, "Auth profile");
  validProvider(value.provider);
  if (typeof value.containerName === "string")
    validIdentifier(value.containerName, "Container name");
  return {
    version: profileVersion,
    agent: value.agent,
    name: value.name,
    provider: value.provider,
    containerName: value.containerName,
    source:
      value.source === "host-pi" || value.source === "host-opencode" ? value.source : "profile",
  };
}

async function assertStageContainerStopped(stage: {
  directory: string;
  metadata: StageMetadata;
}): Promise<void> {
  const name = stage.metadata.containerName;
  if (name !== null && (await managedContainerExists(name))) {
    throw new Error(
      `Credential stage ${stage.directory} is still mounted by container ${name}; stop it before recovery.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
