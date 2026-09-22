import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentNames, type AgentName } from "../agents/registry.ts";
import { encodeApiToken, assertApiTokenProvider, validateApiTokenDocument } from "./credentials.ts";
import { withAuthManagement } from "./management.ts";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
  readBoundedText,
  removeOwnedDirectory,
  writeNewPrivateFile,
  writePrivateFile,
} from "../utils/fs.ts";
import { validIdentifier } from "../state/identifiers.ts";

export const profileVersion = 2;
const maxAuthBytes = 256 * 1024;

export type AuthProfile = {
  agent: AgentName;
  name: string;
  provider: string;
  directory: string;
  authFile: string;
};

type StoredProfile = {
  version: typeof profileVersion;
  agent: AgentName;
  provider: string;
  credentialType: "api-token";
};

/** Create a new source-only API-token profile. Tokens never enter metadata. */
export async function createAuthProfile(input: {
  agent: AgentName;
  name: string;
  provider: string;
  token: string;
}): Promise<AuthProfile> {
  return withAuthManagement(() => createAuthProfileUnlocked(input));
}

async function createAuthProfileUnlocked(input: {
  agent: AgentName;
  name: string;
  provider: string;
  token: string;
}): Promise<AuthProfile> {
  const profile = await profilePaths(input.agent, input.name, input.provider);
  const document = encodeApiToken(input.agent, input.provider, input.token);
  await ensurePrivateStateDirectory(profile.directory);
  const metadataPath = join(profile.directory, "profile.json");
  const created = await writeNewPrivateFile(
    metadataPath,
    `${JSON.stringify(
      {
        version: profileVersion,
        agent: input.agent,
        provider: input.provider,
        credentialType: "api-token",
      } satisfies StoredProfile,
      null,
      2,
    )}\n`,
  );
  if (!created) throw new Error(`Auth profile "${input.name}" already exists.`);
  try {
    const credentialCreated = await writeNewPrivateFile(profile.authFile, document);
    if (!credentialCreated) {
      throw new Error(`Auth profile "${input.name}" already has a credential file.`);
    }
  } catch (error) {
    // Metadata was claimed by this call, but an existing credential may have
    // predated it. Remove only our metadata claim; do not recursively delete
    // an unexpected directory or credential.
    await rm(metadataPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return profile;
}

export async function updateAuthProfile(
  agent: AgentName,
  name: string,
  token: string,
): Promise<AuthProfile> {
  return withAuthManagement(async () => {
    const profile = await loadAuthProfile(agent, name);
    // The management lock prevents removal from recreating a profile directory
    // between validation and this atomic credential replacement.
    await writePrivateFile(profile.authFile, encodeApiToken(agent, profile.provider, token));
    return profile;
  });
}

export async function loadAuthProfile(agent: AgentName, name: string): Promise<AuthProfile> {
  validIdentifier(name, "Auth profile");
  assertProfileName(name);
  const root = await authRoot();
  await assertPrivateProfileDirectory(root);
  await assertPrivateProfileDirectory(join(root, agent));
  const directory = join(root, agent, name);
  await assertPrivateProfileDirectory(directory);
  const metadata = await readProfileMetadata(join(directory, "profile.json"), name);
  if (metadata.agent !== agent)
    throw new Error(`Auth profile "${name}" does not belong to ${agent}.`);
  const profile = await profilePaths(agent, name, metadata.provider);
  validateApiTokenDocument(agent, metadata.provider, await readAuthDocument(profile.authFile));
  return profile;
}

export async function listAuthProfiles(agent?: AgentName): Promise<AuthProfile[]> {
  const root = await authRoot();
  const selectedAgents = agent === undefined ? agentNames : [agent];
  const profiles: AuthProfile[] = [];
  for (const selected of selectedAgents) {
    const directory = join(root, selected);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      profiles.push(await loadAuthProfile(selected, entry.name));
    }
  }
  return profiles.sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
}

export async function removeAuthProfile(agent: AgentName, name: string): Promise<void> {
  return withAuthManagement(() => removeAuthProfileUnlocked(agent, name));
}

async function removeAuthProfileUnlocked(agent: AgentName, name: string): Promise<void> {
  const { profileIsCliDefault } = await import("./defaults.ts");
  if (await profileIsCliDefault(agent, name)) {
    throw new Error(
      `Auth profile "${name}" is configured as the ${agent} CLI default; clear it first.`,
    );
  }
  validIdentifier(name, "Auth profile");
  assertProfileName(name);
  const root = await authRoot();
  await assertPrivateProfileDirectory(root);
  await assertPrivateProfileDirectory(join(root, agent));
  const agentRoot = join(root, agent);
  const directory = join(agentRoot, name);
  // Removal is the actionable recovery path for a recognized version-one
  // profile, but never accepts arbitrary private directories as wrapper state.
  await assertPrivateProfileDirectory(directory);
  await assertRemovableProfileMetadata(join(directory, "profile.json"), agent, name);
  await removeOwnedDirectory(agentRoot, name, async (quarantined) => {
    await assertRemovableProfileMetadata(join(quarantined, "profile.json"), agent, name);
  });
}

export async function readAuthDocument(path: string): Promise<string> {
  const metadata = await lstat(path).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) throw new Error(`Auth credential does not exist: ${path}`);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`Refusing non-regular auth credential: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid)
    throw new Error(`Refusing auth credential not owned by the current user: ${path}`);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`Refusing non-private auth credential: ${path}`);
  return readBoundedText(path, maxAuthBytes);
}

/** Parse untrusted profile/default/stage metadata with prototype-key rejection. */
export async function readAuthMetadata(path: string, label: string): Promise<unknown> {
  return parseJson(await readBoundedText(path, maxAuthBytes), label);
}

export function validProvider(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Provider must contain letters, numbers, dots, underscores, or dashes.");
  }
  return value;
}

export function isAgent(value: unknown): value is AgentName {
  return typeof value === "string" && (agentNames as readonly string[]).includes(value);
}

export function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertProfileName(name: string): void {
  if (name === "host" || name === "none")
    throw new Error(`"${name}" is reserved and cannot be an auth profile name.`);
}

async function assertPrivateProfileFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`Refusing non-private auth profile metadata: ${path}`);
  }
}

async function assertPrivateProfileDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) throw new Error(`Auth profile directory does not exist: ${path}`);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`Refusing non-directory auth profile path: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid)
    throw new Error(`Refusing auth profile not owned by the current user: ${path}`);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`Refusing non-private auth profile directory: ${path}`);
}

async function profilePaths(
  agent: AgentName,
  name: string,
  provider: string,
): Promise<AuthProfile> {
  validIdentifier(name, "Auth profile");
  assertProfileName(name);
  validProvider(provider);
  assertApiTokenProvider(agent, provider);
  const directory = join(await authRoot(), agent, name);
  return { agent, name, provider, directory, authFile: join(directory, "auth.json") };
}

async function authRoot(): Promise<string> {
  return join(await privateStateDirectory(), "auth");
}

async function assertRemovableProfileMetadata(
  path: string,
  agent: AgentName,
  name: string,
): Promise<void> {
  await assertPrivateProfileFile(path);
  const value = await readAuthMetadata(path, "auth profile metadata");
  if (
    isRecord(value) &&
    value.version === 1 &&
    value.agent === agent &&
    typeof value.provider === "string"
  ) {
    validProvider(value.provider);
    return;
  }
  // Version-two removal uses the same strict parser as execution.
  const metadata = await readProfileMetadata(path, name);
  if (metadata.agent !== agent)
    throw new Error(`Auth profile "${name}" does not belong to ${agent}.`);
}

async function readProfileMetadata(path: string, name: string): Promise<StoredProfile> {
  let value: unknown;
  try {
    await assertPrivateProfileFile(path);
    value = await readAuthMetadata(path, "auth profile metadata");
  } catch (error) {
    if (isMissing(error)) throw new Error(`Auth profile "${name}" does not exist.`);
    throw error;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "agent", "provider", "credentialType"]) ||
    value.version !== profileVersion ||
    !isAgent(value.agent) ||
    typeof value.provider !== "string" ||
    value.credentialType !== "api-token"
  ) {
    if (isRecord(value) && value.version === 1)
      throw new Error(
        `Auth profile "${name}" uses legacy version 1 state; remove and recreate it.`,
      );
    throw new Error(`Invalid auth profile metadata: ${path}`);
  }
  validProvider(value.provider);
  assertApiTokenProvider(value.agent, value.provider);
  return {
    version: profileVersion,
    agent: value.agent,
    provider: value.provider,
    credentialType: "api-token",
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    assertNoPrototypeKeys(parsed);
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertNoPrototypeKeys(value: unknown): void {
  if (!isRecord(value)) {
    if (Array.isArray(value)) for (const item of value) assertNoPrototypeKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("forbidden object key");
    }
    assertNoPrototypeKeys(child);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
