import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAuthProfile,
  createAuthProfile,
  loadAuthProfile,
  recoverAuthProfile,
  removeAuthProfileLock,
  stageAuthProfile,
  stageHostAuth,
} from "./recovery.ts";
import { maxAuthStageBytes } from "./staging.ts";
import { assertWorkspaceWithinLimit } from "../resources/storage.ts";

let stateRoot = "";
let previousStateHome: string | undefined;

beforeEach(async () => {
  previousStateHome = Bun.env.XDG_STATE_HOME;
  stateRoot = await mkdtemp(join(tmpdir(), "pi-pod-auth-"));
  Bun.env.XDG_STATE_HOME = stateRoot;
});

afterEach(async () => {
  if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
  else Bun.env.XDG_STATE_HOME = previousStateHome;
  await rm(stateRoot, { recursive: true, force: true });
});

test("rejects a symlinked auth subtree even when its leaf would be user-owned", async () => {
  const state = join(stateRoot, "pi-pod");
  const outside = join(stateRoot, "outside");
  await mkdir(state);
  await mkdir(outside);
  await symlink(outside, join(state, "auth"));

  await expect(
    createAuthProfile({ agent: "pi", name: "default", provider: "openai-codex" }),
  ).rejects.toThrow("escaped the wrapper-owned root");
  expect(await Bun.file(join(outside, "pi", "default", "auth.json")).exists()).toBe(false);
});

test("serializes concurrent creation of the same profile", async () => {
  const results = await Promise.allSettled([
    createAuthProfile({ agent: "opencode", name: "shared", provider: "openai" }),
    createAuthProfile({ agent: "opencode", name: "shared", provider: "anthropic" }),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const stored = await loadAuthProfile("opencode", "shared");
  expect(["openai", "anthropic"]).toContain(stored.provider);
});

test("stages only the selected host Pi credential and never writes it back", async () => {
  const previousHome = Bun.env.HOME;
  const home = join(stateRoot, "home");
  const hostAuth = join(home, ".pi", "agent", "auth.json");
  const source = JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "host-access",
      refresh: "host-refresh",
      expires: 1_900_000_000_000,
    },
    unrelated: { type: "api_key", key: "must-not-stage" },
  });
  try {
    Bun.env.HOME = home;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(hostAuth, source);
    const stage = await stageHostAuth("host-pi");
    expect(JSON.parse(await readFile(stage.authFile, "utf8"))).toEqual({
      "openai-codex": {
        type: "oauth",
        access: "host-access",
        refresh: "host-refresh",
        expires: 1_900_000_000_000,
      },
    });
    await writeFile(
      stage.authFile,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "changed",
          refresh: "changed",
          expires: 1_900_000_000_001,
        },
      }),
    );
    await stage.reconcile();
    await stage.cleanup();
    expect(await readFile(hostAuth, "utf8")).toBe(source);
  } finally {
    if (previousHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = previousHome;
  }
});

test("stages only the selected host OpenCode OpenAI credential and never writes it back", async () => {
  const previousDataHome = Bun.env.XDG_DATA_HOME;
  const dataHome = join(stateRoot, "host-data");
  const hostAuth = join(dataHome, "opencode", "auth.json");
  const source = redactedOpenCodeHostAuthDocument();
  try {
    Bun.env.XDG_DATA_HOME = dataHome;
    await mkdir(join(dataHome, "opencode"), { recursive: true });
    await writeFile(hostAuth, source);
    const stage = await stageHostAuth("host-opencode");
    const staged = JSON.parse(await readFile(stage.authFile, "utf8"));
    expect(Object.keys(staged)).toEqual(["openai"]);
    expect(staged.openai.type).toBe("oauth");
    await writeFile(stage.authFile, "{}\n");
    await stage.reconcile();
    await stage.cleanup();
    expect(await readFile(hostAuth, "utf8")).toBe(source);
  } finally {
    if (previousDataHome === undefined) delete Bun.env.XDG_DATA_HOME;
    else Bun.env.XDG_DATA_HOME = previousDataHome;
  }
});

function redactedOpenCodeHostAuthDocument(): string {
  // Generate opaque values at runtime so fixtures cannot be mistaken for credentials.
  const redacted = crypto.randomUUID();
  return JSON.stringify({
    openai: { type: "oauth", access: redacted, refresh: redacted, expires: 1_900_000_000_000 },
    unrelated: { sentinel: true },
  });
}

test("stages and persists only the selected Pi Codex credential", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "codex",
    provider: "openai-codex",
  });
  const lock = await acquireAuthProfile(profile);
  try {
    const stage = await stageAuthProfile(profile);
    await writeFile(
      stage.authFile,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-id",
        },
      }),
    );
    await stage.reconcile();
    await stage.cleanup();
  } finally {
    await lock.release();
  }

  const stored = JSON.parse(
    await readFile((await loadAuthProfile("pi", "codex")).authFile, "utf8"),
  );
  expect(stored).toEqual({
    "openai-codex": {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: expect.any(Number),
      accountId: "account-id",
    },
  });
});

test("persists the selected native OpenCode API credential", async () => {
  const profile = await createAuthProfile({
    agent: "opencode",
    name: "default",
    provider: "openai",
  });
  const lock = await acquireAuthProfile(profile);
  try {
    const stage = await stageAuthProfile(profile);
    await writeFile(
      stage.authFile,
      JSON.stringify({
        openai: { type: "api", key: "fixture-key", metadata: { region: "test" } },
      }),
    );
    await stage.reconcile();
    await stage.cleanup();
  } finally {
    await lock.release();
  }

  const stored = JSON.parse(await readFile(profile.authFile, "utf8"));
  expect(stored).toEqual({
    openai: { type: "api", key: "fixture-key", metadata: { region: "test" } },
  });
});

test("rejects unrelated providers in a wrapper-owned credential profile", async () => {
  const profile = await createAuthProfile({
    agent: "opencode",
    name: "isolated",
    provider: "openai",
  });
  await writeFile(
    profile.authFile,
    JSON.stringify({
      openai: { type: "api", key: "fixture-key" },
      anthropic: { type: "api", key: "must-not-stage" },
    }),
  );
  await expect(stageAuthProfile(profile)).rejects.toThrow(
    "Credential contains unsupported fields.",
  );
});

test("rejects unsupported credential fields instead of copying them back", async () => {
  const profile = await createAuthProfile({
    agent: "opencode",
    name: "default",
    provider: "openai",
  });
  const lock = await acquireAuthProfile(profile);
  try {
    const stage = await stageAuthProfile(profile);
    await writeFile(
      stage.authFile,
      JSON.stringify({
        openai: { type: "api", key: "fixture-key", injected: "no" },
        anthropic: { type: "api", key: "must-not-persist" },
      }),
    );
    await expect(stage.reconcile()).rejects.toThrow("Credential contains unsupported fields.");
  } finally {
    await lock.release();
  }
});

test("bounds writable native auth staging separately from workspace storage", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "bounded",
    provider: "openai-codex",
  });
  const stage = await stageAuthProfile(profile);
  try {
    await writeFile(
      join(stage.agentStateDirectory, "native-cache"),
      "x".repeat(maxAuthStageBytes + 1),
    );
    await expect(
      assertWorkspaceWithinLimit(
        stage.agentStateDirectory,
        maxAuthStageBytes,
        "Authentication staging",
      ),
    ).rejects.toThrow("Authentication staging storage limit");
  } finally {
    await stage.cleanup();
  }
});

test("recovers a valid interrupted credential stage", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "default",
    provider: "openai-codex",
  });
  const lock = await acquireAuthProfile(profile);
  try {
    const stage = await stageAuthProfile(profile);
    await writeFile(
      stage.authFile,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "new-access",
          refresh: "new-refresh",
          expires: Date.now() + 60_000,
        },
      }),
    );
    // Simulate the wrapper being interrupted after the agent updated its
    // isolated credential file but before reconciliation.
  } finally {
    await lock.release();
  }

  await recoverAuthProfile("pi", "default");
  const stored = JSON.parse(await readFile(profile.authFile, "utf8"));
  expect(stored["openai-codex"].access).toBe("new-access");
});

test("does not recover a stage while its named container still exists", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "default",
    provider: "openai-codex",
  });
  const containerName = "pi-pod-stage-fixture";
  const lock = await acquireAuthProfile(profile, { containerName });
  try {
    await stageAuthProfile(profile, { containerName });
  } finally {
    await lock.release();
  }

  await withExistingContainer(containerName, async () => {
    await expect(recoverAuthProfile("pi", "default")).rejects.toThrow("still mounted by container");
  });
  // The fake only reports this exact name as present. Recovery must retain the
  // stage and the known profile until that container is verified absent.
  expect(await Bun.file(profile.authFile).text()).toBe("{}\n");
  expect(await readdir(join(stateRoot, "pi-pod", "auth-staging"))).toHaveLength(1);
});

test("does not unlock a dead PID while its named container still exists", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "default",
    provider: "openai-codex",
  });
  const containerName = "pi-pod-auth-fixture";
  const lock = await acquireAuthProfile(profile, { containerName });
  try {
    await writeFile(
      join(profile.directory, ".active", "owner.json"),
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
        containerName,
      }),
    );
    await withExistingContainer(containerName, async () => {
      await expect(removeAuthProfileLock("pi", "default")).rejects.toThrow(
        "still mounted by container",
      );
    });
  } finally {
    await lock.release();
  }
});

async function withExistingContainer(name: string, action: () => Promise<void>): Promise<void> {
  const bin = join(stateRoot, "bin");
  const previousPath = Bun.env.PATH;
  await mkdir(bin);
  await writeFile(
    join(bin, "podman"),
    `#!/bin/sh
if test "$1" = container && test "$2" = exists && test "$3" = "${name}"; then exit 0; fi
exit 1
`,
    { mode: 0o700 },
  );
  Bun.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    await action();
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
  }
}

test("rejects command-backed keys and prevents parallel profile use", async () => {
  const profile = await createAuthProfile({
    agent: "pi",
    name: "default",
    provider: "openai-codex",
  });
  const lock = await acquireAuthProfile(profile);
  await expect(acquireAuthProfile(profile)).rejects.toThrow("already in use");
  try {
    const stage = await stageAuthProfile(profile);
    await writeFile(
      stage.authFile,
      JSON.stringify({
        "openai-codex": { type: "api_key", key: "!host-command" },
      }),
    );
    await expect(stage.reconcile()).rejects.toThrow("Invalid OpenAI Codex OAuth credential.");
  } finally {
    await lock.release();
  }
});
