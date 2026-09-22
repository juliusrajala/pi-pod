import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
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

test("configured packages copy only selected files, replacing host package discovery", async () => {
  const source = join(root, "checkout");
  await mkdir(join(source, "extensions"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    '{"name":"fixture","pi":{"extensions":["extensions"]}}',
  );
  await writeFile(join(source, "extensions", "example.ts"), "original");
  await writeFile(join(source, ".env"), "not part of the package copy");
  await writeFile(
    join(Bun.env.HOME!, ".pi/agent/settings.json"),
    JSON.stringify({
      defaultThinkingLevel: "high",
      packages: ["/unrelated/not-allowed"],
    }),
  );
  const stage = await stageHostPiExtensionPackages([
    {
      source,
      files: ["package.json", "extensions"],
      extensions: ["extensions/example.ts"],
    },
  ]);
  expect(stage).toBeDefined();
  const copy = stage!.mounts[0]!.source;
  expect(copy).not.toBe(source);
  expect(copy).toStartWith(Bun.env.XDG_STATE_HOME!);
  expect(await readdir(copy)).toEqual(["extensions", "package.json"]);
  await writeFile(join(source, "extensions", "example.ts"), "changed");
  expect(await readFile(join(copy, "extensions", "example.ts"), "utf8")).toBe("original");
  const settings = JSON.parse(await readFile(stage!.settingsFile, "utf8"));
  expect(settings.defaultThinkingLevel).toBe("high");
  expect(settings.packages[0]).toEqual({
    source: "/run/pi-pod-dev-resources/package-0",
    extensions: ["extensions/example.ts"],
    skills: [],
    prompts: [],
    themes: [],
  });
  await stage!.cleanup();
  expect(await Bun.file(join(copy, "package.json")).exists()).toBe(false);
  expect(await readFile(join(source, "extensions", "example.ts"), "utf8")).toBe("changed");
});

test("package snapshots reject symlink escapes, missing files and oversized copies and clean up", async () => {
  const source = join(root, "checkout");
  await mkdir(source);
  await writeFile(join(source, "package.json"), "{}");
  await writeFile(join(root, "secret"), "must not copy");
  await symlink(join(root, "secret"), join(source, "escape"));
  await symlink(root, join(source, "linked-dir"));
  await writeFile(join(source, "oversized"), "");
  await truncate(join(source, "oversized"), 32 * 1024 * 1024 + 1);
  for (const path of ["escape", "linked-dir/secret", "missing", "oversized"]) {
    await expect(
      stageHostPiExtensionPackages([
        {
          source,
          files: ["package.json", path],
          extensions: [],
        },
      ]),
    ).rejects.toThrow();
    expect(await readdir(join(Bun.env.XDG_STATE_HOME!, "pi-pod/dev-resource-staging"))).toEqual([]);
  }
});

test("empty selection excludes host packages even when their paths would be rejected", async () => {
  await writeFile(
    join(Bun.env.HOME!, ".pi/agent/settings.json"),
    JSON.stringify({
      packages: ["/unrelated/not-allowed"],
    }),
  );
  expect(await stageHostPiExtensionPackages([])).toBeUndefined();
});
