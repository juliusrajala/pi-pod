import { expect, test } from "bun:test";
import type { AgentDefinition } from "./contract.ts";
import { agentDefinition, assertAgentMode, createAgentRegistry } from "./registry.ts";

test("static registry exposes reviewed agents and rejects unknown IDs", () => {
  expect(agentDefinition("pi").hostAuth).toEqual({ provider: "openai-codex", source: "host-pi" });
  expect(agentDefinition("opencode").hostAuth).toEqual({
    provider: "openai",
    source: "host-opencode",
  });
  expect(() => agentDefinition("unreviewed")).toThrow("Unsupported agent");
  expect(() =>
    assertAgentMode({ ...agentDefinition("pi"), modes: ["interactive"] }, "headless"),
  ).toThrow("does not support headless mode");
});

test("registry constructor exercises a fixture integration without loading plugins", () => {
  const fixture: AgentDefinition = {
    id: "fixture",
    modes: ["headless"],
    authDirectory: "/home/agent/.fixture",
    environment: {},
    credentialCodec: { assertProvider: () => {}, normalize: () => ({}) },
    preferenceArguments: () => [],
    command: () => ["fixture"],
    loginCommand: () => ["fixture", "login"],
    loginInstructions: () => "fixture login",
  };
  const registry = createAgentRegistry(["fixture"] as const, [fixture]);
  expect(registry.fixture.command({ mode: "headless", agentArgs: [] })).toEqual(["fixture"]);
  expect(() => createAgentRegistry(["fixture"] as const, [{ ...fixture, id: "other" }])).toThrow(
    "Unknown agent definition",
  );
});
