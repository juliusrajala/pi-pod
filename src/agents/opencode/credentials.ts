import type { CredentialCodec } from "../contract.ts";

/** Selected native OpenCode credentials supported by the pinned integration. */
export const openCodeCredentialCodec: CredentialCodec = {
  assertProvider: () => {},
  normalize(provider, value) {
    if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid OpenCode credential for ${provider}.`);
    if (value.type === "oauth") {
      assertOnlyKeys(value, ["type", "access", "refresh", "expires", "accountId", "enterpriseUrl"]);
      if (
        typeof value.access !== "string" || typeof value.refresh !== "string" ||
        !isNonNegativeInteger(value.expires) ||
        (value.accountId !== undefined && typeof value.accountId !== "string") ||
        (value.enterpriseUrl !== undefined && typeof value.enterpriseUrl !== "string")
      ) throw new Error(`Invalid OpenCode OAuth credential for ${provider}.`);
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
      return { type: "api", key: value.key, ...(value.metadata === undefined ? {} : { metadata: value.metadata }) };
    }
    if (value.type === "wellknown") {
      assertOnlyKeys(value, ["type", "key", "token"]);
      if (typeof value.key !== "string" || typeof value.token !== "string") {
        throw new Error(`Invalid OpenCode well-known credential for ${provider}.`);
      }
      return { type: "wellknown", key: value.key, token: value.token };
    }
    throw new Error(`Unsupported OpenCode credential type for ${provider}.`);
  },
};

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Credential contains unsupported fields.");
}

function isStringRecord(value: unknown): value is Record<string, string> | undefined {
  return value === undefined || (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
