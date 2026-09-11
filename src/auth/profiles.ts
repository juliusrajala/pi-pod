import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSupportedCredentialProvider,
  validateCredentialDocument,
} from "./credentials.ts";
import type { AgentName } from "../types.ts";
import { ensurePrivateStateDirectory, privateStateDirectory, readBoundedText, validIdentifier, writeNewPrivateFile } from "../utils.ts";

export const profileVersion = 1;
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
};

/** Create or validate the persistent, selected-provider credential profile. */
export async function createAuthProfile(input: {
  agent: AgentName;
  name: string;
  provider: string;
}): Promise<AuthProfile> {
  assertSupportedCredentialProvider(input.agent, input.provider);
  const profile = await profilePaths(input.agent, input.name, input.provider);
  await ensurePrivateStateDirectory(profile.directory);
  const metadataPath = join(profile.directory, "profile.json");
  let metadata = await readProfileMetadata(metadataPath).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) {
    const expected: StoredProfile = {
      version: profileVersion,
      agent: input.agent,
      provider: input.provider,
    };
    const created = await writeNewPrivateFile(metadataPath, `${JSON.stringify(expected, null, 2)}\n`);
    metadata = created ? expected : await readProfileMetadata(metadataPath);
  }
  if (metadata.agent !== input.agent || metadata.provider !== input.provider) {
    throw new Error(`Auth profile "${input.name}" already belongs to ${metadata.agent}/${metadata.provider}.`);
  }
  await writeNewPrivateFile(profile.authFile, "{}\n");
  validateCredentialDocument(input.agent, input.provider, await readAuthDocument(profile.authFile));
  return profile;
}

export async function loadAuthProfile(agent: AgentName, name: string): Promise<AuthProfile> {
  validIdentifier(name, "Auth profile");
  const directory = join(await authRoot(), agent, name);
  const metadata = await readProfileMetadata(join(directory, "profile.json"));
  if (metadata.agent !== agent) throw new Error(`Auth profile "${name}" does not belong to ${agent}.`);
  return createAuthProfile({ agent, name, provider: metadata.provider });
}

export async function readAuthDocument(path: string): Promise<string> {
  const metadata = await lstat(path).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata === undefined) return "{}\n";
  return readBoundedText(path, maxAuthBytes);
}

/** Parse untrusted profile, lock, or stage metadata with prototype-key rejection. */
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
  return value === "pi" || value === "opencode";
}

export function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function profilePaths(agent: AgentName, name: string, provider: string): Promise<AuthProfile> {
  validIdentifier(name, "Auth profile");
  validProvider(provider);
  const directory = join(await authRoot(), agent, name);
  return { agent, name, provider, directory, authFile: join(directory, "auth.json") };
}

async function authRoot(): Promise<string> {
  return join(await privateStateDirectory(), "auth");
}

async function readProfileMetadata(path: string): Promise<StoredProfile> {
  const value = await readAuthMetadata(path, "auth profile metadata");
  if (!isRecord(value) || value.version !== profileVersion || !isAgent(value.agent) || typeof value.provider !== "string") {
    throw new Error(`Invalid auth profile metadata: ${path}`);
  }
  validProvider(value.provider);
  return { version: profileVersion, agent: value.agent, provider: value.provider };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
