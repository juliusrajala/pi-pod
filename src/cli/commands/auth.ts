import { Crust } from "@crustjs/core";
import {
  clearCliAuthDefault,
  loadCliAuthDefault,
  profileIsCliDefault,
  setCliAuthDefault,
} from "../../auth/defaults.ts";
import { assertApiTokenProvider } from "../../auth/credentials.ts";
import {
  createAuthProfile,
  listAuthProfiles,
  loadAuthProfile,
  removeAuthProfile,
  updateAuthProfile,
} from "../../auth/profiles.ts";
import { readApiToken } from "../../auth/token-input.ts";
import { agents, type AgentName } from "../../execution/types.ts";
import { requireNoAgentArguments, requireNoExtraArguments } from "./validation.ts";

const scopes = ["profile", "default"] as const;

export const authCommand = new Crust("auth")
  .meta({ description: "Manage pi-pod API-token profiles and CLI auth defaults" })
  .args([
    { name: "scope", type: "string", choices: scopes, required: true },
    { name: "action", type: "string", required: true },
    { name: "arguments", type: "string", variadic: true },
  ] as const)
  .flags({
    agent: { type: "string", choices: agents },
    provider: { type: "string" },
    profile: { type: "string" },
    auth: { type: "string" },
  } as const)
  .run(async ({ args, flags, rawArgs }) => {
    requireNoExtraArguments(args.arguments, "auth");
    requireNoAgentArguments(rawArgs, "auth");
    if (args.scope === "profile") {
      await profileAction(args.action, flags);
    } else {
      await defaultAction(args.action, flags);
    }
  });

async function profileAction(
  action: string,
  flags: { agent?: string; provider?: string; profile?: string },
): Promise<void> {
  if (action === "list") {
    const profiles = await listAuthProfiles(flags.agent as AgentName | undefined);
    for (const profile of profiles)
      console.log(`${profile.agent}\t${profile.name}\t${profile.provider}`);
    return;
  }
  const agent = requireAgent(flags.agent);
  const name = requireProfile(flags.profile);
  if (action === "create") {
    if (flags.provider === undefined) throw new Error("auth profile create requires --provider.");
    assertApiTokenProvider(agent, flags.provider);
    const profile = await createAuthProfile({
      agent,
      name,
      provider: flags.provider,
      token: await readApiToken(),
    });
    console.error(
      `Created API-token profile "${profile.name}" for ${profile.agent}/${profile.provider}.`,
    );
    return;
  }
  if (action === "show") {
    const profile = await loadAuthProfile(agent, name);
    console.log(`${profile.agent}\t${profile.name}\t${profile.provider}`);
    return;
  }
  if (action === "update") {
    await loadAuthProfile(agent, name);
    const profile = await updateAuthProfile(agent, name, await readApiToken());
    console.error(
      `Updated API-token profile "${profile.name}" for ${profile.agent}/${profile.provider}.`,
    );
    return;
  }
  if (action === "remove") {
    if (await profileIsCliDefault(agent, name)) {
      throw new Error(
        `Auth profile "${name}" is configured as the ${agent} CLI default; clear it first.`,
      );
    }
    await removeAuthProfile(agent, name);
    console.error(`Removed API-token profile "${name}" for ${agent}.`);
    return;
  }
  throw new Error(`Unknown auth profile action: ${action}.`);
}

async function defaultAction(
  action: string,
  flags: { agent?: string; auth?: string },
): Promise<void> {
  const agent = requireAgent(flags.agent);
  if (action === "show") {
    const selected = await loadCliAuthDefault(agent);
    console.log(selected === "host" ? "host" : selected.name);
    return;
  }
  if (action === "clear") {
    await clearCliAuthDefault(agent);
    console.error(`Cleared ${agent} CLI authentication default (host will be used).`);
    return;
  }
  if (action === "set") {
    if (flags.auth === undefined) throw new Error("auth default set requires --auth host|PROFILE.");
    if (flags.auth === "none") throw new Error('"none" is not an authentication source.');
    await setCliAuthDefault(agent, flags.auth);
    console.error(`Set ${agent} CLI authentication default to "${flags.auth}".`);
    return;
  }
  throw new Error(`Unknown auth default action: ${action}.`);
}

function requireAgent(value: string | undefined): AgentName {
  if (value === undefined) throw new Error("This auth action requires --agent.");
  return value as AgentName;
}

function requireProfile(value: string | undefined): string {
  if (value === undefined) throw new Error("This auth profile action requires --profile.");
  return value;
}
