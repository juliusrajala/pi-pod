import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCliAuthDefault,
  loadCliAuthDefault,
  profileIsCliDefault,
  setCliAuthDefault,
} from "./defaults.ts";
import {
  createAuthProfile,
  loadAuthProfile,
  removeAuthProfile,
  updateAuthProfile,
} from "./profiles.ts";
import { withAuthManagement } from "./management.ts";
import {
  recoverHostAuthStages,
  recoverPendingAuthStages,
  stageAuthProfile,
  stageHostAuth,
} from "./staging.ts";

let state: string | undefined;
afterEach(async () => {
  if (state !== undefined) await rm(state, { recursive: true, force: true });
  delete Bun.env.XDG_STATE_HOME;
  state = undefined;
});

async function isolatedState(): Promise<void> {
  state = await mkdtemp(join(tmpdir(), "pi-pod-auth-"));
  Bun.env.XDG_STATE_HOME = state;
}

test("both agents stage generic API-token profiles under unlisted safe provider IDs", async () => {
  await isolatedState();
  await expect(
    createAuthProfile({
      agent: "opencode",
      name: "reserved",
      provider: "constructor",
      token: "fake",
    }),
  ).rejects.toThrow("safe provider");
  await expect(
    createAuthProfile({
      agent: "opencode",
      name: "invalid",
      provider: "bad/provider",
      token: "fake",
    }),
  ).rejects.toThrow("safe provider");

  for (const agent of ["opencode", "pi"] as const) {
    const provider = "synthetic-unlisted-provider";
    const profile = await createAuthProfile({
      agent,
      name: "worker",
      provider,
      token: "fake-token",
    });
    expect((await loadAuthProfile(agent, "worker")).provider).toBe(provider);
    const stage = await stageAuthProfile(profile);
    expect(JSON.parse(await Bun.file(stage.authFile).text())).toEqual({
      [provider]: {
        type: agent === "pi" ? "api_key" : "api",
        key: "fake-token",
      },
    });
    await updateAuthProfile(agent, "worker", "new-fake-token");
    expect(await Bun.file(stage.authFile).text()).toContain("fake-token");
    await stage.cleanup();
  }
});

test("profile creation refuses a pre-existing credential instead of reporting success", async () => {
  await isolatedState();
  const directory = join(state!, "pi-pod", "auth", "opencode", "partial");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "auth.json"), '{"anthropic":{"type":"api","key":"old"}}\n', {
    mode: 0o600,
  });
  await expect(
    createAuthProfile({ agent: "opencode", name: "partial", provider: "anthropic", token: "new" }),
  ).rejects.toThrow("already has a credential file");
  expect(await Bun.file(join(directory, "profile.json")).exists()).toBe(false);
  expect(await readFile(join(directory, "auth.json"), "utf8")).toContain("old");
});

test("profile management mutations serialize instead of racing", async () => {
  await isolatedState();
  await createAuthProfile({
    agent: "opencode",
    name: "worker",
    provider: "anthropic",
    token: "fake",
  });
  await withAuthManagement(async () => {
    await expect(updateAuthProfile("opencode", "worker", "replacement")).rejects.toThrow(
      "management is already in progress",
    );
  });
});

test("profile removal refuses unrecognized metadata", async () => {
  await isolatedState();
  const directory = join(state!, "pi-pod", "auth", "opencode", "unknown");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "profile.json"), '{"version":99}\n', { mode: 0o600 });
  await expect(removeAuthProfile("opencode", "unknown")).rejects.toThrow(
    "Invalid auth profile metadata",
  );
  expect((await lstat(directory)).isDirectory()).toBe(true);
});

test("host Pi staging filters the selected credential and never writes back", async () => {
  await isolatedState();
  const previousHome = Bun.env.HOME;
  const home = join(state!, "home");
  const hostAuth = join(home, ".pi", "agent", "auth.json");
  const selected = crypto.randomUUID();
  const source = JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: selected,
      refresh: selected,
      expires: 1_900_000_000_000,
    },
    unrelated: { type: "api", key: crypto.randomUUID() },
  });
  try {
    Bun.env.HOME = home;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(hostAuth, source);
    const stage = await stageHostAuth("host-pi");
    expect(Object.keys(JSON.parse(await readFile(stage.authFile, "utf8")))).toEqual([
      "openai-codex",
    ]);
    await writeFile(stage.authFile, "{}\n", { mode: 0o600 });
    await stage.reconcile();
    await stage.cleanup();
    expect(await readFile(hostAuth, "utf8")).toBe(source);
  } finally {
    if (previousHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = previousHome;
  }
});

test("host OpenCode staging filters the selected credential and never writes back", async () => {
  await isolatedState();
  const previousDataHome = Bun.env.XDG_DATA_HOME;
  const dataHome = join(state!, "data");
  const hostAuth = join(dataHome, "opencode", "auth.json");
  const selected = crypto.randomUUID();
  const source = JSON.stringify({
    openai: { type: "oauth", access: selected, refresh: selected, expires: 1_900_000_000_000 },
    unrelated: { type: "api", key: crypto.randomUUID() },
  });
  try {
    Bun.env.XDG_DATA_HOME = dataHome;
    await mkdir(join(dataHome, "opencode"), { recursive: true });
    await writeFile(hostAuth, source);
    const stage = await stageHostAuth("host-opencode");
    expect(Object.keys(JSON.parse(await readFile(stage.authFile, "utf8")))).toEqual(["openai"]);
    await writeFile(stage.authFile, "{}\n", { mode: 0o600 });
    await stage.reconcile();
    await stage.cleanup();
    expect(await readFile(hostAuth, "utf8")).toBe(source);
  } finally {
    if (previousDataHome === undefined) delete Bun.env.XDG_DATA_HOME;
    else Bun.env.XDG_DATA_HOME = previousDataHome;
  }
});

test("host recovery preserves live startup stages and removes a dead orphan", async () => {
  await isolatedState();
  const previousHome = Bun.env.HOME;
  const home = join(state!, "home");
  try {
    Bun.env.HOME = home;
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    const selected = crypto.randomUUID();
    await writeFile(
      join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({
        "openai-codex": { type: "oauth", access: selected, refresh: selected, expires: 1 },
      }),
    );
    const live = await stageHostAuth("host-pi");
    const orphan = await stageHostAuth("host-pi");
    try {
      await writeFile(
        join(orphan.directory, "stage.json"),
        JSON.stringify({
          version: 2,
          agent: "pi",
          name: "host-pi",
          provider: "openai-codex",
          containerName: null,
          ownershipToken: null,
          pid: 2_147_483_647,
          source: "host-pi",
        }),
        { mode: 0o600 },
      );
      await recoverHostAuthStages("host-pi");
      expect((await lstat(live.directory)).isDirectory()).toBe(true);
      await expect(lstat(orphan.directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await live.cleanup();
      await orphan.cleanup();
    }
  } finally {
    if (previousHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = previousHome;
  }
});

test("profile stages are independent and discard native writes", async () => {
  await isolatedState();
  const profile = await createAuthProfile({
    agent: "opencode",
    name: "worker",
    provider: "anthropic",
    token: "fake-token",
  });
  const first = await stageAuthProfile(profile);
  const second = await stageAuthProfile(profile);
  expect(first.directory).not.toBe(second.directory);
  await writeFile(first.authFile, '{"anthropic":{"type":"api","key":"changed"}}\n', {
    mode: 0o600,
  });
  await first.cleanup();
  await second.cleanup();
  expect(await Bun.file(profile.authFile).text()).toContain("fake-token");
});

test("orphaned profile stages are discarded without writing back", async () => {
  await isolatedState();
  const profile = await createAuthProfile({
    agent: "opencode",
    name: "worker",
    provider: "anthropic",
    token: "fake-token",
  });
  const stage = await stageAuthProfile(profile);
  await writeFile(stage.authFile, '{"anthropic":{"type":"api","key":"changed"}}\n', {
    mode: 0o600,
  });
  await writeFile(
    join(stage.directory, "stage.json"),
    JSON.stringify({
      version: 2,
      agent: "opencode",
      name: "worker",
      provider: "anthropic",
      containerName: null,
      ownershipToken: null,
      pid: 2_147_483_647,
      source: "profile",
    }),
    { mode: 0o600 },
  );
  await recoverPendingAuthStages(profile);
  await expect(lstat(stage.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(profile.authFile, "utf8")).toContain("fake-token");
});

test("reserved profile identifiers are rejected consistently", async () => {
  await isolatedState();
  for (const name of ["host", "none"]) {
    await expect(
      createAuthProfile({ agent: "opencode", name, provider: "anthropic", token: "fake" }),
    ).rejects.toThrow("reserved");
  }
});

test("CLI defaults are per agent, validate profile ownership, and clear to host", async () => {
  await isolatedState();
  await createAuthProfile({
    agent: "opencode",
    name: "worker",
    provider: "anthropic",
    token: "fake",
  });
  await setCliAuthDefault("opencode", "worker");
  expect(await loadCliAuthDefault("opencode")).toEqual({ type: "profile", name: "worker" });
  expect(await profileIsCliDefault("opencode", "worker")).toBe(true);
  await clearCliAuthDefault("opencode");
  expect(await loadCliAuthDefault("opencode")).toBe("host");
});

test("recovery rejects a symlinked auth-staging root", async () => {
  await isolatedState();
  const root = join(state!, "pi-pod");
  const outside = await mkdtemp(join(tmpdir(), "pi-pod-outside-"));
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await symlink(outside, join(root, "auth-staging"));
    await expect(recoverHostAuthStages()).rejects.toThrow("escaped the wrapper-owned root");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("version-one state is rejected without modification", async () => {
  await isolatedState();
  const directory = join(state!, "pi-pod", "auth", "opencode", "legacy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "profile.json"),
    '{"version":1,"agent":"opencode","provider":"anthropic"}\n',
    { mode: 0o600 },
  );
  await expect(loadAuthProfile("opencode", "legacy")).rejects.toThrow("legacy version 1");
});
