import { Crust } from "@crustjs/core";
import { login } from "../../run.ts";
import { agents, type AgentName } from "../../types.ts";
import { reexecInDelegatedScope } from "../delegation.ts";
import { interruptSignal } from "../signals.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

export const loginCommand = new Crust("login")
  .meta({ description: "Authenticate an agent in an isolated container" })
  .args([{ name: "arguments", type: "string", variadic: true }] as const)
  .flags({
    agent: { type: "string", choices: agents, required: true },
    provider: { type: "string", required: true },
    profile: { type: "string" },
    image: { type: "string" },
  } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "login");
    requireNoAgentArguments(rawArgs, "login");
    if (await reexecInDelegatedScope(process.argv.slice(2))) return;
    const interrupt = interruptSignal();
    try {
      const result = await login({
        agent: flags.agent as AgentName,
        provider: flags.provider,
        profile: flags.profile,
        image: flags.image,
        signal: interrupt.signal,
        onDiagnostic: (message) => console.error(`pi-pod: ${message}`),
      });
      console.error(`Saved ${result.agent}/${result.provider} credentials in profile "${result.profile}".`);
    } finally {
      interrupt.dispose();
    }
  });
