import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPodmanAvailable, podmanNeedsDelegatedScope } from "./args.ts";

async function withPodmanInfo(info: unknown, action: () => Promise<void>): Promise<void> {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "pi-pod-preflight-XXXXXX")}`.text();
  const directory = root.trim();
  const podman = join(directory, "podman");
  const previousPath = Bun.env.PATH;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(podman, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(info)}'\n`);
    await chmod(podman, 0o755);
    Bun.env.PATH = `${directory}:${previousPath}`;
    await action();
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test("requires cgroup v2 and rejects remote Podman", async () => {
  const rootlessV1 = {
    host: {
      os: "linux",
      cgroupVersion: "v1",
      serviceIsRemote: false,
      security: { rootless: true },
    },
  };
  await withPodmanInfo(rootlessV1, async () => {
    await expect(assertPodmanAvailable()).rejects.toThrow("cgroup v2");
  });

  const noMemoryController = {
    host: {
      os: "linux",
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "pids"],
      serviceIsRemote: false,
      security: { rootless: true },
    },
  };
  await withPodmanInfo(noMemoryController, async () => {
    await expect(assertPodmanAvailable()).rejects.toThrow("cgroup controller");
    expect(await podmanNeedsDelegatedScope()).toBe(true);
  });

  const remote = {
    host: {
      os: "linux",
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "memory", "pids"],
      serviceIsRemote: true,
      security: { rootless: true },
    },
  };
  await withPodmanInfo(remote, async () => {
    await expect(assertPodmanAvailable()).rejects.toThrow("remote Podman");
  });
});
