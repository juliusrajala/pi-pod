import { expect, test } from "bun:test";
import { resolveRunPolicy } from "./policy.ts";

test("resolves library and CLI-shared defaults without filesystem access", () => {
  const dev = resolveRunPolicy({ mode: "interactive", workspace: "/workspace" });
  expect(dev.agent).toBe("pi");
  expect(dev.workspaceMode).toBe("bind");
  expect(dev.credentialSource).toEqual({ source: "host" });

  const run = resolveRunPolicy({ mode: "headless", workspace: "/workspace" });
  expect(run.workspaceMode).toBe("clone");
  expect(run.credentialSource).toEqual({ source: "profile", profileName: "default" });
  expect(run.timeoutMs).toBe(600_000);
});

test("translates trusted library preferences without filesystem configuration loading", () => {
  const policy = resolveRunPolicy({
    mode: "headless",
    agent: "opencode",
    workspace: "/workspace",
    preferences: { model: { provider: "openai", id: "fixture" }, variant: "high" },
  });
  expect(policy.preferenceArgs).toEqual(["--model", "openai/fixture", "--variant", "high"]);
});

test("rejects headless host credentials during pure policy resolution", () => {
  expect(() =>
    resolveRunPolicy({ mode: "headless", workspace: "/workspace", authProfile: "host" }),
  ).toThrow("Host credentials are available only to interactive dev sessions");
});
