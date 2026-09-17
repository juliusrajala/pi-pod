import { expect, test } from "bun:test";
import { openCodeDefinition } from "./opencode/definition.ts";
import { piDefinition } from "./pi/definition.ts";

test("Pi definition preserves fixed headless discovery controls and prompt transport", () => {
  expect(piDefinition.command({ mode: "headless", agentArgs: ["--model", "fixture"] })).toEqual([
    "pi", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--print", "--model", "fixture", "",
  ]);
  const command = piDefinition.command({ mode: "headless", promptPath: "/run/pi-pod-prompt", agentArgs: ["--model", "fixture"] });
  expect(command.slice(0, 5)).toEqual(["sh", "-c", expect.stringContaining('cat -- "$1"'), "pi-pod-prompt", "/run/pi-pod-prompt"]);
  expect(command.slice(5)).toEqual(["--model", "fixture"]);
  expect(piDefinition.preferenceArguments({ model: { provider: "openai-codex", id: "fixture" }, thinking: "high" }, []))
    .toEqual(["--provider", "openai-codex", "--model", "fixture", "--thinking", "high"]);
  expect(piDefinition.preferenceArguments({ model: { provider: "openai-codex", id: "fixture" }, thinking: "high" }, ["--model", "native"]))
    .toEqual(["--thinking", "high"]);
});

test("OpenCode definition retains bundled authentication and native prompt transport", () => {
  expect(openCodeDefinition.command({ mode: "interactive", agentArgs: ["--model", "openai/fixture"] }))
    .toEqual(["opencode", "--pure", "--model", "openai/fixture"]);
  const command = openCodeDefinition.command({ mode: "headless", promptPath: "/run/pi-pod-prompt", agentArgs: ["--model", "openai/fixture"] });
  expect(command.slice(0, 5)).toEqual(["sh", "-c", expect.stringContaining("opencode run --pure --auto"), "pi-pod-prompt", "/run/pi-pod-prompt"]);
  expect(command.slice(5)).toEqual(["--model", "openai/fixture"]);
  expect(openCodeDefinition.environment.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined();
  expect(openCodeDefinition.preferenceArguments({ model: { provider: "openai", id: "fixture" }, variant: "high" }, []))
    .toEqual(["--model", "openai/fixture", "--variant", "high"]);
  expect(openCodeDefinition.preferenceArguments({ model: { provider: "openai", id: "fixture" }, variant: "high" }, ["-m", "native", "--variant=max"]))
    .toEqual([]);
});
