import { agentDefinition } from "../agents/registry.ts";
import type { AgentName } from "../agents/registry.ts";

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

export function normalizedCredentialDocument(
  agent: AgentName,
  provider: string,
  text: string,
): string {
  return `${JSON.stringify({ [provider]: selectedCredential(agent, provider, text, true) }, null, 2)}\n`;
}

/** Filter an interactive host document to its one reviewed native provider. */
export function normalizedHostCredentialDocument(
  agent: AgentName,
  provider: string,
  text: string,
): string {
  return `${JSON.stringify({ [provider]: selectedCredential(agent, provider, text, true, true) }, null, 2)}\n`;
}

export function assertSupportedCredentialProvider(agent: AgentName, provider: string): void {
  agentDefinition(agent).credentialCodec.assertProvider(provider);
}

/** The reviewed API-token matrix is deliberately smaller than host OAuth support. */
export function assertApiTokenProvider(agent: AgentName, provider: string): void {
  if (agent !== "opencode" || provider !== "anthropic") {
    throw new Error(
      `API-token profiles do not support ${agent}/${provider}. Supported combination: opencode/anthropic.`,
    );
  }
}

/** Encode the exact pinned native document; never accept caller-supplied JSON. */
export function encodeApiToken(agent: AgentName, provider: string, token: string): string {
  assertApiTokenProvider(agent, provider);
  if (typeof token !== "string" || token.length === 0 || token.length > 16 * 1024) {
    throw new Error("API token must be nonempty and at most 16384 characters.");
  }
  return `${JSON.stringify({ [provider]: { type: "api", key: token } })}\n`;
}

/** Profiles accept only the exact source-only API-token shape, not native OAuth extras. */
export function validateApiTokenDocument(agent: AgentName, provider: string, text: string): void {
  assertApiTokenProvider(agent, provider);
  const document = parseJson(text, "auth.json");
  if (!isRecord(document) || Object.keys(document).length !== 1 || !isRecord(document[provider])) {
    throw new Error("Invalid API-token credential document.");
  }
  const credential = document[provider];
  if (
    Object.keys(credential).length !== 2 ||
    credential.type !== "api" ||
    typeof credential.key !== "string" ||
    credential.key.length === 0 ||
    credential.key.length > 16 * 1024
  ) {
    throw new Error("Invalid API-token credential document.");
  }
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
    if (requireCredential)
      throw new Error(`Authentication did not create a credential for ${provider}.`);
    return {};
  }
  return agentDefinition(agent).credentialCodec.normalize(provider, value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Credential contains unsupported fields.");
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
    if (key === "__proto__" || key === "prototype" || key === "constructor")
      throw new Error("forbidden object key");
    assertNoPrototypeKeys(child);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
