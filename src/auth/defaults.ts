import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentName } from "../agents/registry.ts";
import { agentNames } from "../agents/registry.ts";
import { privateStateDirectory, readBoundedText, writePrivateFile } from "../utils/fs.ts";
import { validIdentifier } from "../state/identifiers.ts";
import { isMissing, loadAuthProfile } from "./profiles.ts";
import { withAuthManagement } from "./management.ts";

const defaultsVersion = 1;
const maxDefaultsBytes = 16 * 1024;
export type CliAuthReference = "host" | { type: "profile"; name: string };

type StoredDefaults = {
  version: typeof defaultsVersion;
  agents: Partial<Record<AgentName, { auth: string }>>;
};

export async function loadCliAuthDefault(agent: AgentName): Promise<CliAuthReference> {
  const state = await readDefaults();
  const auth = state.agents[agent]?.auth;
  if (auth === undefined || auth === "host") return "host";
  validProfileName(auth);
  await loadAuthProfile(agent, auth);
  return { type: "profile", name: auth };
}

export async function setCliAuthDefault(agent: AgentName, auth: string): Promise<void> {
  await withAuthManagement(async () => {
    const state = await readDefaults();
    if (auth !== "host") {
      validProfileName(auth);
      await loadAuthProfile(agent, auth);
    }
    state.agents[agent] = { auth };
    await writeDefaults(state);
  });
}

export async function clearCliAuthDefault(agent: AgentName): Promise<void> {
  await withAuthManagement(async () => {
    const state = await readDefaults();
    delete state.agents[agent];
    await writeDefaults(state);
  });
}

export async function profileIsCliDefault(agent: AgentName, name: string): Promise<boolean> {
  const state = await readDefaults();
  return state.agents[agent]?.auth === name;
}

async function defaultsPath(): Promise<string> {
  return join(await privateStateDirectory(), "auth-defaults.json");
}

async function readDefaults(): Promise<StoredDefaults> {
  const path = await defaultsPath();
  let text: string;
  try {
    const metadata = await lstat(path);
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (uid !== undefined && metadata.uid !== uid) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Refusing non-private CLI authentication defaults.");
    }
    text = await readBoundedText(path, maxDefaultsBytes);
  } catch (error) {
    if (isMissing(error)) return { version: defaultsVersion, agents: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid CLI authentication defaults.");
  }
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["version", "agents"]) ||
    value.version !== defaultsVersion ||
    !isRecord(value.agents)
  ) {
    throw new Error("Invalid CLI authentication defaults.");
  }
  const agents: StoredDefaults["agents"] = {};
  for (const [agent, entry] of Object.entries(value.agents)) {
    if (
      !(agentNames as readonly string[]).includes(agent) ||
      !isRecord(entry) ||
      !onlyKeys(entry, ["auth"]) ||
      typeof entry.auth !== "string"
    ) {
      throw new Error("Invalid CLI authentication defaults.");
    }
    if (entry.auth !== "host") validProfileName(entry.auth);
    agents[agent as AgentName] = { auth: entry.auth };
  }
  return { version: defaultsVersion, agents };
}

async function writeDefaults(value: StoredDefaults): Promise<void> {
  await writePrivateFile(await defaultsPath(), `${JSON.stringify(value, null, 2)}\n`);
}

function validProfileName(name: string): void {
  validIdentifier(name, "Auth profile");
  if (name === "host" || name === "none") throw new Error(`"${name}" is not an auth profile name.`);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
