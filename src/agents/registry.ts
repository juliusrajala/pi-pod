import { agentNames, type AgentDefinition, type AgentName } from "./contract.ts";
import { openCodeDefinition } from "./opencode/definition.ts";
import { piDefinition } from "./pi/definition.ts";

const definitions = createAgentRegistry(agentNames, [piDefinition, openCodeDefinition]);

export { agentNames };
export type { AgentDefinition, AgentName };

/** Resolve a reviewed built-in integration; unknown IDs never fall back. */
export function agentDefinition(agent: string): AgentDefinition {
  const definition = definitions[agent as AgentName];
  if (definition === undefined) throw new Error(`Unsupported agent: ${agent}`);
  return definition;
}

/** Internal testable constructor; production uses only the static definitions above. */
export function createAgentRegistry<Name extends string>(
  names: readonly Name[],
  definitions: readonly AgentDefinition[],
): Readonly<Record<Name, AgentDefinition>> {
  const registry = {} as Record<Name, AgentDefinition>;
  for (const definition of definitions) {
    const name = definition.id as Name;
    if (!names.includes(name)) throw new Error(`Unknown agent definition: ${definition.id}`);
    if (registry[name] !== undefined)
      throw new Error(`Duplicate agent definition: ${definition.id}`);
    registry[name] = definition;
  }
  for (const name of names) {
    if (registry[name] === undefined) throw new Error(`Missing built-in agent definition: ${name}`);
  }
  return registry;
}

export function assertAgentMode(agent: AgentDefinition, mode: "interactive" | "headless"): void {
  if (!agent.modes.includes(mode)) throw new Error(`${agent.id} does not support ${mode} mode.`);
}
