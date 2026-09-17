import { Crust } from "@crustjs/core";
import { resolve } from "node:path";
import { defaultImage } from "../../container/image.ts";
import { isCompiledRuntime } from "../bootstrap.ts";
import { releaseBuildRecipe } from "../distribution.ts";
import { hostToolEnvironment } from "../../utils/process.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

export const buildCommand = new Crust("build")
  .meta({ description: "Build the pinned agent image" })
  .args([{ name: "arguments", type: "string", variadic: true }] as const)
  .flags({ image: { type: "string", default: defaultImage } } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "build");
    requireNoAgentArguments(rawArgs, "build");
    const layout = isCompiledRuntime()
      ? await releaseBuildRecipe()
      : (() => {
          const root = resolve(import.meta.dir, "..", "..", "..");
          const context = resolve(root, "container");
          return { context, containerfile: resolve(context, "Containerfile") };
        })();
    const process = Bun.spawn(
      ["podman", "build", "--tag", flags.image, "--file", layout.containerfile, layout.context],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: hostToolEnvironment(),
      },
    );
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`Image build exited with status ${exitCode}.`);
  });
