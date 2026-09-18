import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostPiExtensionsDirectory, stageHostPiExtensionPackages } from "./dev-resources.ts";

let root = "";
let previousHome: string | undefined;
let previousStateHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-pod-dev-resources-"));
  previousHome = Bun.env.HOME;
  previousStateHome = Bun.env.XDG_STATE_HOME;
  Bun.env.HOME = join(root, "home");
  Bun.env.XDG_STATE_HOME = join(root, "state");
  await mkdir(join(Bun.env.HOME, ".pi", "agent"), { recursive: true });
});

afterEach(async () => {
  if (previousHome === undefined) delete Bun.env.HOME;
  else Bun.env.HOME = previousHome;
  if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
  else Bun.env.XDG_STATE_HOME = previousStateHome;
  await rm(root, { recursive: true, force: true });
});

test("stages only local host extension packages in filtered Pi settings", async () => {
  const agent = join(Bun.env.HOME!, ".pi", "agent");
  const packageRoot = join(agent, "packages", "extensions-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-terra",
      defaultThinkingLevel: "high",
      packages: [
        { source: packageRoot, extensions: ["extensions/example.ts"], skills: ["must-not-copy"] },
      ],
    }),
  );

  const stage = await stageHostPiExtensionPackages();
  expect(stage).toBeDefined();
  expect(stage!.mounts).toEqual([
    { source: packageRoot, destination: "/run/pi-pod-dev-resources/package-0" },
  ]);
  expect(JSON.parse(await readFile(stage!.settingsFile, "utf8"))).toEqual({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-terra",
    defaultThinkingLevel: "high",
    packages: [
      {
        source: "/run/pi-pod-dev-resources/package-0",
        extensions: ["extensions/example.ts"],
        skills: [],
        prompts: [],
        themes: [],
      },
    ],
  });
  await stage!.cleanup();
});

test("rejects host extension packages outside explicit roots", async () => {
  const agent = join(Bun.env.HOME!, ".pi", "agent");
  const packageRoot = join(root, "outside-package");
  await mkdir(packageRoot);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [packageRoot] }));

  await expect(stageHostPiExtensionPackages()).rejects.toThrow(
    "outside the allowed extension roots",
  );
});

test("rejects non-local host extension packages instead of installing them in dev", async () => {
  const agent = join(Bun.env.HOME!, ".pi", "agent");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ packages: ["npm:unreviewed-extension"] }),
  );

  await expect(stageHostPiExtensionPackages()).rejects.toThrow("not a local path");
});

test("finds the direct global extension directory when present", async () => {
  const directory = join(Bun.env.HOME!, ".pi", "agent", "extensions");
  await mkdir(directory);

  expect(await hostPiExtensionsDirectory()).toBe(directory);
});
