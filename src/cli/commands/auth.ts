import { Crust } from "@crustjs/core";
import {
  discardPendingAuthStages,
  recoverAuthProfile,
  removeAuthProfileLock,
} from "../../auth/recovery.ts";
import { agents, type AgentName } from "../../execution/types.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

const actions = ["recover", "discard", "unlock"] as const;

export const authCommand = new Crust("auth")
  .meta({ description: "Recover or discard interrupted credential staging" })
  .args([
    { name: "action", type: "string", choices: actions, required: true },
    { name: "arguments", type: "string", variadic: true },
  ] as const)
  .flags({
    agent: { type: "string", choices: agents, required: true },
    profile: { type: "string", default: "default" },
  } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "auth");
    requireNoAgentArguments(rawArgs, "auth");
    const agent = flags.agent as AgentName;
    if (args.action === "recover") await recoverAuthProfile(agent, flags.profile);
    else if (args.action === "discard") await discardPendingAuthStages(agent, flags.profile);
    else await removeAuthProfileLock(agent, flags.profile);
    console.error(`Auth ${args.action} completed for ${agent} profile "${flags.profile}".`);
  });
