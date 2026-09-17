import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateStateDirectory,
  privateStateDirectory,
  writePrivateFile,
} from "../utils/fs.ts";

export const maxPromptBytes = 256 * 1024;

export type PromptStage = {
  file: string;
  cleanup: () => Promise<void>;
};

/**
 * Keep task text out of the host Podman argv. The file is mounted read-only at
 * a fixed container path and is retained when container removal is uncertain.
 */
export async function stagePrompt(prompt: string): Promise<PromptStage> {
  if (prompt.includes("\0")) throw new Error("Prompt must not contain NUL bytes.");
  if (new TextEncoder().encode(prompt).byteLength > maxPromptBytes) {
    throw new Error(`Prompt exceeds ${maxPromptBytes} bytes.`);
  }
  const directory = join(await privateStateDirectory(), "prompt-staging", crypto.randomUUID());
  await ensurePrivateStateDirectory(directory);
  const file = join(directory, "task.txt");
  await writePrivateFile(file, prompt);
  let cleaned = false;
  return {
    file,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
