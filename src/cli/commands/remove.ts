import { Crust } from "@crustjs/core";
import { removeAgentRun } from "../../run.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

export const removeCommand = new Crust("remove")
  .meta({ description: "Remove a retained clone after review" })
  .args([
    { name: "run-id", type: "string", required: true },
    { name: "arguments", type: "string", variadic: true },
  ] as const)
  .run(async ({ args, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "remove");
    requireNoAgentArguments(rawArgs, "remove");
    await removeAgentRun(args["run-id"]);
    console.error(`Removed retained run ${args["run-id"]}.`);
  });
