import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOutput } from "./utils.ts";
import { prepareWorkspace, releaseRunReservation, removeRun } from "./workspace.ts";

let root = "";
let previousStateHome: string | undefined;

beforeEach(async () => {
  previousStateHome = Bun.env.XDG_STATE_HOME;
  root = await Bun.$`mktemp -d ${join(tmpdir(), "pi-pod-workspace-XXXXXX")}`.text();
  root = root.trim();
  Bun.env.XDG_STATE_HOME = join(root, "state");
});

afterEach(async () => {
  if (previousStateHome === undefined) delete Bun.env.XDG_STATE_HOME;
  else Bun.env.XDG_STATE_HOME = previousStateHome;
  await rm(root, { recursive: true, force: true });
});

test("rejects a workspace that would mount wrapper state", async () => {
  const source = await gitFixture();
  const configuredStateHome = join(source, ".state");
  const original = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = configuredStateHome;
  try {
    await expect(prepareWorkspace({ path: source, mode: "bind" })).rejects.toThrow("Workspace overlaps pi-pod state");
  } finally {
    Bun.env.XDG_STATE_HOME = original;
  }
});

test("rejects a workspace that canonically contains state through a dangling XDG symlink", async () => {
  const source = await gitFixture();
  const stateParent = join(source, ".state");
  const xdgLink = join(root, "state-link");
  await symlink(stateParent, xdgLink);
  const original = Bun.env.XDG_STATE_HOME;
  Bun.env.XDG_STATE_HOME = xdgLink;
  try {
    await expect(prepareWorkspace({ path: source, mode: "bind" })).rejects.toThrow("Workspace overlaps pi-pod state");
    expect(await Bun.file(join(stateParent, "pi-pod")).exists()).toBe(false);
  } finally {
    Bun.env.XDG_STATE_HOME = original;
  }
});

test("does not remove a run directory without wrapper metadata", async () => {
  const run = join(root, "state", "pi-pod", "runs", "unowned");
  const sentinel = join(run, "valuable-work");
  await mkdir(run, { recursive: true });
  await writeFile(sentinel, "do not remove\n");

  await expect(removeRun("unowned")).rejects.toThrow("without valid wrapper metadata");
  expect(await Bun.file(sentinel).text()).toBe("do not remove\n");
});

test("does not follow a symlinked runs directory when removing a run", async () => {
  const state = join(root, "state", "pi-pod");
  const outside = join(root, "outside");
  const sentinel = join(outside, "unowned", "valuable-work");
  await mkdir(join(outside, "unowned"), { recursive: true });
  await writeFile(sentinel, "do not remove\n");
  await mkdir(state, { recursive: true });
  await symlink(outside, join(state, "runs"));

  await expect(removeRun("unowned")).rejects.toThrow("escaped the wrapper-owned root");
  expect(await Bun.file(sentinel).text()).toBe("do not remove\n");
});

test("does not remove a dead wrapper's clone while its recorded container exists", async () => {
  const run = join(root, "state", "pi-pod", "runs", "orphan");
  const sentinel = join(run, "valuable-work");
  const fakeBin = join(root, "bin");
  await mkdir(run, { recursive: true });
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "podman"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "podman"), 0o755);
  await writeFile(join(run, "run.json"), `${JSON.stringify({
    version: 1,
    id: "orphan",
    reservation: {
      containerName: "pi-pod-orphan",
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
    },
  })}\n`);
  await writeFile(sentinel, "do not remove\n");
  const originalPath = Bun.env.PATH;
  Bun.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    await expect(removeRun("orphan")).rejects.toThrow("still mounted by container pi-pod-orphan");
    expect(await Bun.file(sentinel).text()).toBe("do not remove\n");
  } finally {
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
  }
});

test("clone mode uses local HEAD without ignored files or a shared object store", async () => {
  const source = await gitFixture();
  await writeFile(join(source, ".env"), "source-only-secret\n");
  await writeFile(join(source, ".gitignore"), ".env\n");
  await git(["add", ".gitignore"], source);
  await git(["commit", "-m", "ignore env"], source);
  const baseRevision = (await git(["rev-parse", "HEAD"], source)).trim();

  const workspace = await prepareWorkspace({ path: source, mode: "clone", runId: "run-1" });

  expect(workspace.owned).toBe(true);
  expect(workspace.baseRevision).toBe(baseRevision);
  expect(await Bun.file(join(workspace.path, ".env")).exists()).toBe(false);
  expect((await git(["remote"], workspace.path)).trim()).toBe("");
  expect(await Bun.file(join(workspace.path, ".git", "objects", "info", "alternates")).exists()).toBe(false);
  expect((await git(["rev-parse", "--abbrev-ref", "HEAD"], workspace.path)).trim()).toBe("pi-pod/run-1");
  expect((await git(["status", "--porcelain"], source)).trim()).toBe("");

  await removeRun("run-1");
  expect(await Bun.file(workspace.path).exists()).toBe(false);
});

test("does not remove a clone while its wrapper reservation is active", async () => {
  const source = await gitFixture();
  const workspace = await prepareWorkspace({
    path: source,
    mode: "clone",
    runId: "reserved",
    containerName: "pi-pod-reserved",
  });
  const sentinel = join(workspace.path, "uncommitted-agent-work");
  await writeFile(sentinel, "keep this while startup is in progress\n");

  await expect(removeRun("reserved")).rejects.toThrow("still being prepared");
  expect(await Bun.file(sentinel).text()).toBe("keep this while startup is in progress\n");

  await releaseRunReservation("reserved", "pi-pod-reserved");
  await removeRun("reserved");
  expect(await Bun.file(workspace.path).exists()).toBe(false);
});

test("rejects a duplicate run ID without deleting retained work", async () => {
  const source = await gitFixture();
  const first = await prepareWorkspace({ path: source, mode: "clone", runId: "retained" });
  const sentinel = join(first.path, "uncommitted-agent-work");
  await writeFile(sentinel, "keep this retained work\n");

  await expect(prepareWorkspace({ path: source, mode: "clone", runId: "retained" })).rejects.toThrow("already exists");
  expect(await Bun.file(sentinel).text()).toBe("keep this retained work\n");
});

test("rejects source filter attributes before Git can run their host command", async () => {
  const source = await gitFixture();
  const marker = join(root, "filter-executed");
  await writeFile(join(source, ".gitattributes"), "tracked.txt filter=host-marker\n");
  await git(["add", ".gitattributes"], source);
  await git(["commit", "-m", "add filter attribute"], source);
  await git(["config", "filter.host-marker.clean", `sh -c 'printf executed > ${marker}; cat'`], source);
  await Bun.sleep(1_100); // Avoid Git's racy-clean timestamp shortcut.
  await writeFile(join(source, "tracked.txt"), "dirty\n");

  await expect(prepareWorkspace({ path: source, mode: "clone", runId: "filter" })).rejects.toThrow("reject Git filter attributes");
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("clone mode rejects dirty source repositories and bind mode rejects linked worktrees", async () => {
  const source = await gitFixture();
  await writeFile(join(source, "tracked.txt"), "dirty\n");
  await expect(prepareWorkspace({ path: source, mode: "clone", runId: "dirty" })).rejects.toThrow("clean Git repository");

  const linked = join(root, "linked");
  await git(["worktree", "add", "--detach", linked], source);
  await expect(prepareWorkspace({ path: linked, mode: "bind" })).rejects.toThrow("external Git metadata");
});

async function gitFixture(): Promise<string> {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await git(["init", "--quiet"], source);
  await git(["config", "user.name", "Test"], source);
  await git(["config", "user.email", "test@example.invalid"], source);
  await writeFile(join(source, "tracked.txt"), "base\n");
  await git(["add", "tracked.txt"], source);
  await git(["commit", "-m", "base"], source);
  return source;
}

async function git(args: string[], cwd: string): Promise<string> {
  return commandOutput(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
}
