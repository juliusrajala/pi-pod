import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { normalizedHostCredentialDocument } from "./credentials.ts";
import { readBoundedText } from "../utils/fs.ts";

const maxHostAuthBytes = 1024 * 1024;

/** Read only the selected credential from the developer's existing Pi login. */
export async function hostPiCodexCredential(): Promise<string> {
  const path = join(hostPiAgentDirectory(), "auth.json");
  return readHostCredential("pi", "openai-codex", path, "Pi");
}

/** Read only OpenCode's built-in OpenAI session, not its wider host state. */
export async function hostOpenCodeOpenAiCredential(): Promise<string> {
  const path = join(hostOpenCodeDataDirectory(), "auth.json");
  return readHostCredential("opencode", "openai", path, "OpenCode");
}

async function readHostCredential(
  agent: "pi" | "opencode",
  provider: string,
  path: string,
  label: string,
): Promise<string> {
  try {
    return normalizedHostCredentialDocument(
      agent,
      provider,
      await readBoundedText(path, maxHostAuthBytes),
    );
  } catch (error) {
    if (isMissing(error)) throw new Error(`Host ${label} credential does not exist: ${path}`);
    throw error;
  }
}

function hostPiAgentDirectory(): string {
  return join(hostHomeDirectory(), ".pi", "agent");
}

function hostOpenCodeDataDirectory(): string {
  const home = hostHomeDirectory();
  const configured = Bun.env.XDG_DATA_HOME?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new Error("XDG_DATA_HOME must be an absolute path for host authentication.");
  }
  const dataHome = configured || join(home, ".local", "share");
  return join(dataHome, "opencode");
}

function hostHomeDirectory(): string {
  const configured = Bun.env.HOME?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new Error("HOME must be an absolute path for host authentication.");
  }
  return configured || homedir();
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
