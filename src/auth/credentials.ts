import { agentDefinition } from "../agents/registry.ts";
import type { AgentName } from "../types.ts";

/**
 * Parse a bounded untrusted auth document and dispatch its selected native
 * credential to the statically selected agent codec. Profiles never copy
 * arbitrary provider state or general agent configuration.
 */
export function validateCredentialDocument(
  agent: AgentName,
  provider: string,
  text: string,
  requireCredential = false,
): void {
  selectedCredential(agent, provider, text, requireCredential);
}

export function normalizedCredentialDocument(agent: AgentName, provider: string, text: string): string {
  return `${JSON.stringify({ [provider]: selectedCredential(agent, provider, text, true) }, null, 2)}\n`;
}

/** Filter an interactive host document to its one reviewed native provider. */
export function normalizedHostCredentialDocument(agent: AgentName, provider: string, text: string): string {
  return `${JSON.stringify({ [provider]: selectedCredential(agent, provider, text, true, true) }, null, 2)}\n`;
}

export function assertSupportedCredentialProvider(agent: AgentName, provider: string): void {
  agentDefinition(agent).credentialCodec.assertProvider(provider);
}

function selectedCredential(
  agent: AgentName,
  provider: string,
  text: string,
  requireCredential: boolean,
  allowUnrelatedProviders = false,
): Record<string, unknown> {
  const document = parseJson(text, "auth.json");
  if (!isRecord(document)) throw new Error("Invalid auth.json: expected an object.");
  if (!allowUnrelatedProviders) assertOnlyKeys(document, [provider]);
  const value = document[provider];
  if (value === undefined) {
    if (requireCredential) throw new Error(`Authentication did not create a credential for ${provider}.`);
    return {};
  }
  return agentDefinition(agent).credentialCodec.normalize(provider, value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Credential contains unsupported fields.");
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
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error("forbidden object key");
    assertNoPrototypeKeys(child);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
