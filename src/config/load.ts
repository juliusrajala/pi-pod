import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { agentNames, type AgentName } from "../agents/registry.ts";
import type { RunMode } from "../execution/types.ts";
import { readBoundedText } from "../utils/fs.ts";
import { parsePiPackages, type PiDevPackage } from "./pi-packages.ts";
import {
  assertModelPreference,
  hasOnlyKeys,
  isBoundedNonemptyString,
  isPiThinkingLevel,
  isRecord,
  type AgentPreferences,
  type ModelPreference,
} from "./types.ts";

const maxConfigurationBytes = 256 * 1024;

type ModeSection = {
  preferences?: AgentPreferences;
  packages?: PiDevPackage[];
};

type ConfigurationDocument = Partial<Record<AgentName, Partial<Record<RunMode, ModeSection>>>>;

/** Load only an explicit file or the conventional interactive-dev configuration. */
export async function loadCliConfiguration(input: {
  mode: RunMode;
  agent: AgentName;
  configPath?: string;
  noConfig?: boolean;
}): Promise<ModeSection | undefined> {
  if (input.configPath !== undefined && input.noConfig) {
    throw new Error("--config and --no-config cannot be used together.");
  }
  if (input.noConfig || (input.mode === "headless" && input.configPath === undefined))
    return undefined;

  const path =
    input.configPath === undefined
      ? conventionalConfigPath()
      : explicitConfigPath(input.configPath);
  const text = await readConfiguration(path, input.configPath === undefined);
  if (text === undefined) return undefined;
  const document = parseConfiguration(text);
  return document[input.agent]?.[input.mode];
}

export async function loadCliPreferences(
  input: Parameters<typeof loadCliConfiguration>[0],
): Promise<AgentPreferences | undefined> {
  return (await loadCliConfiguration(input))?.preferences;
}

/** Conventional dev-only path; a configured XDG base must not be cwd-relative. */
export function conventionalConfigPath(environment = Bun.env): string {
  const configured = environment.XDG_CONFIG_HOME?.trim();
  const base = configured || join(environment.HOME?.trim() || homedir(), ".config");
  if (!isAbsolute(base)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  return join(base, "pi-pod", "config.json");
}

function explicitConfigPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("--config must be an absolute path.");
  return path;
}

async function readConfiguration(path: string, optional: boolean): Promise<string | undefined> {
  try {
    return await readBoundedText(path, maxConfigurationBytes);
  } catch (error) {
    if (optional && isMissing(error)) return undefined;
    if (isMissing(error)) throw new Error(`Configuration file does not exist: ${path}`);
    throw new Error(`Could not read configuration file: ${path}`);
  }
}

/** Parse the full non-secret document before selecting its agent/mode section. */
export function parseConfiguration(text: string): ConfigurationDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
    assertNoPrototypeKeys(value);
  } catch {
    throw new Error("Configuration must be valid JSON.");
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "agents"]) || value.version !== 1) {
    throw new Error("Configuration requires version 1 and only supported top-level fields.");
  }
  if (value.agents === undefined) return {};
  if (!isRecord(value.agents)) throw new Error("Configuration agents must be an object.");

  const document: ConfigurationDocument = {};
  let hasResources = false;
  for (const [agent, agentValue] of Object.entries(value.agents)) {
    if (!(agentNames as readonly string[]).includes(agent))
      throw new Error(`Unsupported configuration agent: ${agent}.`);
    const parsed = parseAgentSections(agent as AgentName, agentValue);
    document[agent as AgentName] = parsed.sections;
    hasResources ||= parsed.hasResources;
  }
  if (hasResources) {
    throw new Error("Configuration resources are not supported in checkpoint D1.");
  }
  return document;
}

function parseAgentSections(
  agent: AgentName,
  value: unknown,
): { sections: Partial<Record<RunMode, ModeSection>>; hasResources: boolean } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["dev", "run"])) {
    throw new Error(`Configuration agents.${agent} supports only dev and run sections.`);
  }
  let hasResources = false;
  const sections: Partial<Record<RunMode, ModeSection>> = {};
  for (const [sectionName, sectionValue] of Object.entries(value)) {
    if (sectionName !== "dev" && sectionName !== "run")
      throw new Error(`Configuration agents.${agent} supports only dev and run sections.`);
    const mode: RunMode = sectionName === "dev" ? "interactive" : "headless";
    const parsed = parseModeSection(agent, sectionName, sectionValue);
    sections[mode] = { preferences: parsed.preferences, packages: parsed.packages };
    hasResources ||= parsed.hasResources;
  }
  return { sections, hasResources };
}

function parseModeSection(
  agent: AgentName,
  mode: "dev" | "run",
  value: unknown,
): { preferences?: AgentPreferences; packages?: PiDevPackage[]; hasResources: boolean } {
  const field = `agents.${agent}.${mode}`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["model", "preferences", "resources", "packages"])) {
    throw new Error(`${field} contains unsupported fields.`);
  }
  if (value.packages !== undefined && (agent !== "pi" || mode !== "dev")) {
    throw new Error("Package copies are supported only in agents.pi.dev.packages.");
  }
  const model = value.model === undefined ? undefined : parseModel(value.model, `${field}.model`);
  const native =
    value.preferences === undefined
      ? {}
      : parseNativePreferences(agent, value.preferences, `${field}.preferences`);
  const preferences =
    model === undefined && Object.keys(native).length === 0 ? undefined : { model, ...native };
  return {
    ...(preferences === undefined ? {} : { preferences }),
    ...(value.packages === undefined ? {} : { packages: parsePiPackages(value.packages) }),
    hasResources:
      value.resources === undefined
        ? false
        : validateResources(agent, value.resources, `${field}.resources`),
  };
}

function parseModel(value: unknown, field: string): ModelPreference {
  try {
    assertModelPreference(value, field);
  } catch {
    throw new Error(`${field} requires nonempty provider and id strings.`);
  }
  return { provider: value.provider, id: value.id };
}

function parseNativePreferences(
  agent: AgentName,
  value: unknown,
  field: string,
): Omit<AgentPreferences, "model"> {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  if (agent === "pi") {
    if (!hasOnlyKeys(value, ["thinking"])) throw new Error(`${field} supports only thinking.`);
    if (value.thinking === undefined) return {};
    if (!isPiThinkingLevel(value.thinking)) {
      throw new Error(
        `${field}.thinking must be one of off, minimal, low, medium, high, xhigh, or max.`,
      );
    }
    return { thinking: value.thinking };
  }
  if (!hasOnlyKeys(value, ["variant"])) throw new Error(`${field} supports only variant.`);
  if (value.variant === undefined) return {};
  if (!isBoundedNonemptyString(value.variant, 128)) {
    throw new Error(`${field}.variant must be a nonempty string up to 128 characters.`);
  }
  return { variant: value.variant };
}

function validateResources(agent: AgentName, value: unknown, field: string): true {
  const allowed = agent === "pi" ? ["extensions", "skills"] : ["plugins", "skills"];
  if (!isRecord(value) || !hasOnlyKeys(value, allowed))
    throw new Error(`${field} contains unsupported resource categories.`);
  for (const [name, entries] of Object.entries(value)) {
    if (!Array.isArray(entries) || entries.some((entry) => !isBoundedNonemptyString(entry))) {
      throw new Error(`${field}.${name} must be an array of nonempty resource identifiers.`);
    }
  }
  return true;
}

function assertNoPrototypeKeys(value: unknown): void {
  if (!isRecord(value)) {
    if (Array.isArray(value)) for (const entry of value) assertNoPrototypeKeys(entry);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new Error("forbidden object key");
    assertNoPrototypeKeys(child);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
