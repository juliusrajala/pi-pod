import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conventionalConfigPath, loadCliPreferences, parseConfiguration } from "./load.ts";

let root = "";
let previousHome: string | undefined;
let previousConfigHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-pod-config-"));
  previousHome = Bun.env.HOME;
  previousConfigHome = Bun.env.XDG_CONFIG_HOME;
  Bun.env.HOME = join(root, "home");
  Bun.env.XDG_CONFIG_HOME = join(root, "xdg-config");
});

afterEach(async () => {
  if (previousHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = previousHome;
  if (previousConfigHome === undefined) delete Bun.env.XDG_CONFIG_HOME;
  else Bun.env.XDG_CONFIG_HOME = previousConfigHome;
  await rm(root, { recursive: true, force: true });
});

const piDev = JSON.stringify({
  version: 1,
  agents: { pi: { dev: { model: { provider: "openai-codex", id: "fixture" }, preferences: { thinking: "high" } } } },
});

test("loads the optional XDG dev configuration and selects only agent/mode preferences", async () => {
  const path = conventionalConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, piDev);

  expect(await loadCliPreferences({ mode: "interactive", agent: "pi" })).toEqual({
    model: { provider: "openai-codex", id: "fixture" }, thinking: "high",
  });
  expect(await loadCliPreferences({ mode: "interactive", agent: "opencode" })).toBeUndefined();
});

test("explicit config replaces automatic config and headless never reads it implicitly", async () => {
  const automatic = conventionalConfigPath();
  const explicit = join(root, "explicit.json");
  await mkdir(join(automatic, ".."), { recursive: true });
  await writeFile(automatic, "not json");
  await writeFile(explicit, JSON.stringify({
    version: 1,
    agents: {
      pi: {
        dev: { preferences: { thinking: "low" } },
        run: { model: { provider: "openai-codex", id: "headless" } },
      },
    },
  }));

  expect(await loadCliPreferences({ mode: "interactive", agent: "pi", configPath: explicit })).toEqual({ thinking: "low" });
  expect(await loadCliPreferences({ mode: "headless", agent: "pi" })).toBeUndefined();
  expect(await loadCliPreferences({ mode: "headless", agent: "pi", configPath: explicit }))
    .toEqual({ model: { provider: "openai-codex", id: "headless" } });
});

test("validates hostile and unsupported configuration before selecting a section", async () => {
  const path = join(root, "config.json");
  await writeFile(path, piDev);
  const linked = join(root, "linked.json");
  await symlink(path, linked);

  await expect(loadCliPreferences({ mode: "interactive", agent: "pi", configPath: linked }))
    .rejects.toThrow("Could not read configuration file");
  expect(() => parseConfiguration(JSON.stringify({ version: 2 }))).toThrow("version 1");
  expect(() => parseConfiguration(JSON.stringify({ version: 1, agents: { unknown: {} } }))).toThrow("Unsupported configuration agent");
  expect(() => parseConfiguration(JSON.stringify({ version: 1, agents: { pi: { dev: { model: { provider: "", id: "x" } } } } })))
    .toThrow("requires nonempty provider and id");
  expect(() => parseConfiguration(JSON.stringify({ version: 1, agents: { pi: { dev: { resources: { extensions: [] } } } } })))
    .toThrow("resources are not supported in checkpoint D1");
});

test("supported repository examples remain valid D1 documents", async () => {
  const pi = await readFile(join(import.meta.dir, "..", "..", "config", "agents", "pi.dev.json"), "utf8");
  const opencode = await readFile(join(import.meta.dir, "..", "..", "config", "agents", "opencode.dev.json"), "utf8");
  expect(parseConfiguration(pi).pi?.interactive?.preferences).toEqual({
    model: { provider: "openai-codex", id: "your-model-id" }, thinking: "high",
  });
  expect(parseConfiguration(opencode).opencode?.interactive?.preferences).toEqual({
    model: { provider: "openai", id: "your-model-id" }, variant: "high",
  });
});

test("requires absolute configured and explicit paths and honors no-config", async () => {
  const automatic = conventionalConfigPath();
  await mkdir(join(automatic, ".."), { recursive: true });
  await writeFile(automatic, "not json");
  expect(() => conventionalConfigPath({ XDG_CONFIG_HOME: "relative", HOME: join(root, "home") }))
    .toThrow("must be an absolute path");
  await expect(loadCliPreferences({ mode: "interactive", agent: "pi", configPath: "relative.json" }))
    .rejects.toThrow("--config must be an absolute path");
  await expect(loadCliPreferences({ mode: "interactive", agent: "pi", configPath: join(root, "missing.json") }))
    .rejects.toThrow("Configuration file does not exist");
  expect(await loadCliPreferences({ mode: "interactive", agent: "pi", noConfig: true })).toBeUndefined();
  await expect(loadCliPreferences({ mode: "interactive", agent: "pi", configPath: join(root, "x.json"), noConfig: true }))
    .rejects.toThrow("cannot be used together");
});

test("rejects oversized automatic configuration and supports the HOME fallback", async () => {
  const automatic = conventionalConfigPath();
  await mkdir(join(automatic, ".."), { recursive: true });
  await writeFile(automatic, "x".repeat(256 * 1024 + 1));
  await expect(loadCliPreferences({ mode: "interactive", agent: "pi" })).rejects.toThrow("Could not read configuration file");

  delete Bun.env.XDG_CONFIG_HOME;
  const fallback = conventionalConfigPath();
  await mkdir(join(fallback, ".."), { recursive: true });
  await writeFile(fallback, piDev);
  expect(await loadCliPreferences({ mode: "interactive", agent: "pi" })).toEqual({
    model: { provider: "openai-codex", id: "fixture" }, thinking: "high",
  });
});
