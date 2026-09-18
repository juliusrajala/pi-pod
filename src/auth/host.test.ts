import { expect, test } from "bun:test";
import { hostOpenCodeOpenAiCredential, hostPiCodexCredential } from "./host.ts";
import { privateStateDirectory } from "../utils/fs.ts";

test("rejects relative HOME before reading Pi host credentials", async () => {
  const previousHome = Bun.env.HOME;
  try {
    Bun.env.HOME = "relative-home";
    await expect(hostPiCodexCredential()).rejects.toThrow("HOME must be an absolute path");
  } finally {
    if (previousHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = previousHome;
  }
});

test("rejects relative XDG data and state paths", async () => {
  const previousDataHome = Bun.env.XDG_DATA_HOME;
  const previousStateHome = Bun.env.XDG_STATE_HOME;
  try {
    Bun.env.XDG_DATA_HOME = "relative-data";
    await expect(hostOpenCodeOpenAiCredential()).rejects.toThrow(
      "XDG_DATA_HOME must be an absolute path",
    );
    Bun.env.XDG_DATA_HOME = "/tmp/pi-pod-test-data";
    Bun.env.XDG_STATE_HOME = "relative-state";
    await expect(privateStateDirectory()).rejects.toThrow(
      "XDG_STATE_HOME must be an absolute path",
    );
  } finally {
    if (previousDataHome === undefined) delete Bun.env.XDG_DATA_HOME;
    else Bun.env.XDG_DATA_HOME = previousDataHome;
    if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
    else Bun.env.XDG_STATE_HOME = previousStateHome;
  }
});
