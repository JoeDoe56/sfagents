/**
 * The note an agent gets when the person hands the conversation to it: which
 * agent and model replied before, which reply now, and what access changed.
 */

import type { AgentDefinition, AgentNode } from '@sfagents/core';

/** One side of a switch: the agent, and the model and account it replies with. */
export interface SwitchSide {
  node: AgentNode;
  model: string;
  account: string;
}

const list = (v: readonly string[] | undefined): string => (v?.length ? [...v].sort().join(', ') : 'none');
const mcp = (d: Readonly<AgentDefinition>): string[] =>
  (d.tools?.mcpServers ?? []).map((s) => (typeof s === 'string' ? s : `${s.server}${s.tools?.length ? ` (${s.tools.join(', ')})` : ''}`));
const name = (s: SwitchSide): string => s.node.definition.name ?? s.node.id;
const model = (s: SwitchSide): string => `${s.model}${s.account ? ` via ${s.account}` : ''}`;

/** What changed in the agent's access between `from` and `to`, one line each. */
export function accessChanges(from: AgentNode, to: AgentNode): string[] {
  const a = from.definition;
  const b = to.definition;
  const out: string[] = [];
  const cmp = (label: string, x: string, y: string) => {
    if (x !== y) out.push(`${label}: ${x} → ${y}`);
  };
  cmp('network', a.network, b.network);
  cmp('host folders', list(a.folders), list(b.folders));
  cmp('agents you can message', list([...from.grants.keys()]), list([...to.grants.keys()]));
  cmp('MCP servers', list(mcp(a)), list(mcp(b)));
  cmp('auto-approved MCP tools', list(a.tools?.autoApprove), list(b.tools?.autoApprove));
  cmp('conversation access', a.conversation?.access ?? 'organize', b.conversation?.access ?? 'organize');
  cmp('artifact access', a.artifacts?.access ?? 'create', b.artifacts?.access ?? 'create');
  return out;
}

/** The note for the next prompt, or undefined when nothing changed after all. */
export function switchNote(from: SwitchSide, to: SwitchSide): string | undefined {
  const sameAgent = from.node.id === to.node.id;
  if (sameAgent && model(from) === model(to)) return undefined;
  const head = sameAgent
    ? `[SF Agents] The person switched your model from ${model(from)} to ${model(to)}.`
    : `[SF Agents] The person switched the replying agent from ${name(from)} (model ${model(from)}) to ${name(to)} (model ${model(to)}). You are ${name(to)} now; earlier replies in this conversation were written by ${name(from)}.`;
  const changes = sameAgent ? [] : accessChanges(from.node, to.node);
  const access = changes.length ? `Your permissions and access changed:\n${changes.map((c) => `- ${c}`).join('\n')}` : 'Your permissions and access did not change.';
  return `${head}\n${access}`;
}
