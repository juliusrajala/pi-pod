import { homedir } from "node:os";
import { join } from "node:path";
import { normalizedHostCredentialDocument } from "./credentials.ts";
import { readBoundedText } from "../utils/fs.ts";

const maxHostAuthBytes = 1024 * 1024;

/** Read only the selected credential from the developer's existing Pi login. */
export async function hostPiCodexCredential(): Promise<string> {
  const path = join(hostPiAgentDirectory(), "auth.json");
  try {
    return normalizedHostCredentialDocument("pi", "openai-codex", await readBoundedText(path, maxHostAuthBytes));
  } catch (error) {
    if (isMissing(error)) throw new Error(`Host Pi credential does not exist: ${path}`);
    throw error;
  }
}

function hostPiAgentDirectory(): string {
  return join(Bun.env.HOME?.trim() || homedir(), ".pi", "agent");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
