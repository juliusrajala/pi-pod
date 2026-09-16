import type { AgentName } from "../types.ts";

/**
 * Validate only credential shapes that pi-pod can safely stage and persist.
 * This is intentionally narrower than either agent's full configuration: the
 * wrapper copies back one selected provider credential, never arbitrary state.
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
  const credential = selectedCredential(agent, provider, text, true);
  return `${JSON.stringify({ [provider]: credential }, null, 2)}\n`;
}

/** Filter the explicitly interactive-only host document to one selected provider. */
export function normalizedHostCredentialDocument(agent: AgentName, provider: string, text: string): string {
  const credential = selectedCredential(agent, provider, text, true, true);
  return `${JSON.stringify({ [provider]: credential }, null, 2)}\n`;
}

export function assertSupportedCredentialProvider(agent: AgentName, provider: string): void {
  if (agent === "pi" && provider !== "openai-codex") {
    throw new Error(`Pi credential profiles currently support only openai-codex; use --auth none with an explicit API-key environment variable for another provider.`);
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
  // A profile is a selected-provider credential store, not an agent settings
  // directory. Reject every other provider rather than staging it for native
  // agent discovery or silently retaining an unknown credential shape.
  if (!allowUnrelatedProviders) assertOnlyKeys(document, [provider]);
  const value = document[provider];
  if (value === undefined) {
    if (requireCredential) throw new Error(`Authentication did not create a credential for ${provider}.`);
    return {};
  }
  return agent === "pi"
    ? parsePiCredential(provider, value)
    : parseOpenCodeCredential(provider, value);
}

function parsePiCredential(provider: string, value: unknown): Record<string, unknown> {
  assertSupportedCredentialProvider("pi", provider);
  if (!isRecord(value) || value.type !== "oauth") throw new Error("Invalid OpenAI Codex OAuth credential.");
  assertOnlyKeys(value, ["type", "access", "refresh", "expires", "accountId"]);
  if (
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    typeof value.refresh !== "string" ||
    value.refresh.length === 0 ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    (value.accountId !== undefined && typeof value.accountId !== "string")
  ) {
    throw new Error("Invalid OpenAI Codex OAuth credential.");
  }
  return {
    type: "oauth",
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
  };
}

function parseOpenCodeCredential(provider: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid OpenCode credential for ${provider}.`);
  if (value.type === "oauth") {
    assertOnlyKeys(value, ["type", "access", "refresh", "expires", "accountId", "enterpriseUrl"]);
    if (
      typeof value.access !== "string" ||
      typeof value.refresh !== "string" ||
      !isNonNegativeInteger(value.expires) ||
      (value.accountId !== undefined && typeof value.accountId !== "string") ||
      (value.enterpriseUrl !== undefined && typeof value.enterpriseUrl !== "string")
    ) {
      throw new Error(`Invalid OpenCode OAuth credential for ${provider}.`);
    }
    return {
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
      ...(value.enterpriseUrl === undefined ? {} : { enterpriseUrl: value.enterpriseUrl }),
    };
  }
  if (value.type === "api") {
    assertOnlyKeys(value, ["type", "key", "metadata"]);
    if (typeof value.key !== "string" || !isStringRecord(value.metadata)) {
      throw new Error(`Invalid OpenCode API credential for ${provider}.`);
    }
    return {
      type: "api",
      key: value.key,
      ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    };
  }
  if (value.type === "wellknown") {
    assertOnlyKeys(value, ["type", "key", "token"]);
    if (typeof value.key !== "string" || typeof value.token !== "string") {
      throw new Error(`Invalid OpenCode well-known credential for ${provider}.`);
    }
    return { type: "wellknown", key: value.key, token: value.token };
  }
  throw new Error(`Unsupported OpenCode credential type for ${provider}.`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Credential contains unsupported fields.");
  }
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
