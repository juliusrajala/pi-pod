import { Crust } from "@crustjs/core";
import { authCommand } from "./commands/auth.ts";
import { devCommand, runCommand } from "./commands/agent.ts";
import { buildCommand } from "./commands/build.ts";
import { loginCommand } from "./commands/login.ts";
import { removeCommand } from "./commands/remove.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./commands/validation.ts";
import { isWrapperHelpRequest, usage } from "./help.ts";

const helpCommand = new Crust("help")
  .meta({ description: "Show command usage" })
  .args([{ name: "arguments", type: "string", variadic: true }] as const)
  .run(({ args, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "help");
    requireNoAgentArguments(rawArgs, "help");
    console.log(usage);
  });

export const app = new Crust("pi-pod")
  .meta({ description: "Run Pi and OpenCode in a hardened rootless Podman workspace" })
  .command(buildCommand)
  .command(loginCommand)
  .command(devCommand)
  .command(runCommand)
  .command(removeCommand)
  .command(authCommand)
  .command(helpCommand);

/** Parse and route all wrapper arguments before a command action reaches state or Podman. */
export async function executeCli(argv: readonly string[]): Promise<void> {
  if (isWrapperHelpRequest(argv)) {
    console.log(usage);
    return;
  }
  await app.execute({ argv: normalizeConfigOptOut(argv) });
}

/** Crust reserves `no-*` flag names; retain the public --no-config spelling. */
export function normalizeConfigOptOut(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  const wrapper = argv
    .slice(0, separator === -1 ? argv.length : separator)
    .map((value) => (value === "--no-config" ? "--skip-config" : value));
  return separator === -1 ? wrapper : [...wrapper, ...argv.slice(separator)];
}
