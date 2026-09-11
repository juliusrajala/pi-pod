import { Crust } from "@crustjs/core";
import { resolve } from "node:path";
import { hostToolEnvironment } from "../../utils.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

const defaultImage = "localhost/pi-pod:0.1.0";

export const buildCommand = new Crust("build")
  .meta({ description: "Build the pinned agent image" })
  .args([{ name: "arguments", type: "string", variadic: true }] as const)
  .flags({ image: { type: "string", default: defaultImage } } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "build");
    requireNoAgentArguments(rawArgs, "build");
    const root = resolve(import.meta.dir, "..", "..", "..");
    const context = resolve(root, "container");
    const process = Bun.spawn([
      "podman",
      "build",
      "--tag",
      flags.image,
      "--file",
      resolve(context, "Containerfile"),
      context,
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: hostToolEnvironment(),
    });
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`Image build exited with status ${exitCode}.`);
  });
