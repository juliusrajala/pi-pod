import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxPromptBytes, stagePrompt } from "./prompt.ts";

test("stages a bounded prompt in private state and removes it on cleanup", async () => {
  const root = (await Bun.$`mktemp -d ${join(tmpdir(), "pi-pod-prompt-XXXXXX")}`.text()).trim();
  const previousStateHome = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = join(root, "state");
  try {
    const stage = await stagePrompt("task text\n");
    expect(await Bun.file(stage.file).text()).toBe("task text\n");
    await stage.cleanup();
    expect(await Bun.file(stage.file).exists()).toBe(false);
    await expect(stagePrompt("x".repeat(maxPromptBytes + 1))).rejects.toThrow("Prompt exceeds");
  } finally {
    if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = previousStateHome;
    await rm(root, { recursive: true, force: true });
  }
});
