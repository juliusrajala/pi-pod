import type { CredentialCodec } from "../contract.ts";

/** Pi host authentication deliberately supports only the reviewed Codex OAuth shape. */
export const piCredentialCodec: CredentialCodec = {
  assertProvider(provider) {
    if (provider !== "openai-codex") {
      throw new Error(
        "Pi host authentication supports only openai-codex. Pi API-token profiles are not advertised.",
      );
    }
  },
  normalize(provider, value) {
    this.assertProvider(provider);
    if (!isRecord(value) || value.type !== "oauth")
      throw new Error("Invalid OpenAI Codex OAuth credential.");
    assertOnlyKeys(value, ["type", "access", "refresh", "expires", "accountId"]);
    if (
      typeof value.access !== "string" ||
      value.access.length === 0 ||
      typeof value.refresh !== "string" ||
      value.refresh.length === 0 ||
      typeof value.expires !== "number" ||
      !Number.isFinite(value.expires) ||
      (value.accountId !== undefined && typeof value.accountId !== "string")
    )
      throw new Error("Invalid OpenAI Codex OAuth credential.");
    return {
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    };
  },
};

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Credential contains unsupported fields.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
