/**
 * Terminal permission prompts for tool calls that need approval.
 */

import type { Interface as ReadlineInterface } from 'node:readline';
import {
  stripAnsiAndControl,
  type ConfirmationDecision,
  type ConfirmationHandler,
  type ToolCallConfirmationDetails,
} from '@sfagents/core';
import { createStyle } from './style.js';
import type { EventRenderer } from './render.js';

const MAX_DIFF_LINES = 60;

function describe(details: ToolCallConfirmationDetails, color: ReturnType<typeof createStyle>): string[] {
  switch (details.type) {
    case 'exec':
      return [`  $ ${stripAnsiAndControl(details.command)}`, color.dim(`    in ${details.cwd}`)];
    case 'edit': {
      const lines = stripAnsiAndControl(details.fileDiff).split('\n');
      const body = lines.slice(0, MAX_DIFF_LINES).map((l) =>
        l.startsWith('+') && !l.startsWith('+++') ? color.green(l) : l.startsWith('-') && !l.startsWith('---') ? color.red(l) : color.dim(l),
      );
      if (lines.length > MAX_DIFF_LINES) body.push(color.dim(`  … ${lines.length - MAX_DIFF_LINES} more diff lines`));
      return [`  ${details.filePath}`, ...body.map((l) => `    ${l}`)];
    }
    case 'mcp': {
      const args = stripAnsiAndControl(JSON.stringify(details.args));
      return [`  server: ${details.serverName}   tool: ${details.toolName}`, `  args: ${args.length > 600 ? `${args.slice(0, 600)}…` : args}`];
    }
    case 'info':
      return [`  ${stripAnsiAndControl(details.prompt)}`];
  }
}

/**
 * Builds a ConfirmationHandler that asks on the given readline interface.
 * Prompts are serialized so concurrent requests never interleave.
 */
export function createTerminalConfirm(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  renderer?: EventRenderer,
): ConfirmationHandler {
  const color = createStyle(output as NodeJS.WriteStream);
  let chain: Promise<unknown> = Promise.resolve();
  return (request, signal) => {
    const ask = async (): Promise<ConfirmationDecision> => {
      if (signal.aborted) return 'deny';
      renderer?.breakLine();
      const who = request.agentPath.join(' > ');
      const lines = [
        '',
        color.yellow(`? ${who} wants to use ${color.bold(request.toolName)}: ${stripAnsiAndControl(request.details.title)}`),
        ...describe(request.details, color),
      ];
      output.write(lines.join('\n') + '\n');
      while (true) {
        const answer = await new Promise<string | null>((resolve) => {
          const onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
          rl.question(color.bold('  Allow? [y]es once / [a]lways for this tool / [n]o: '), (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          });
        });
        if (answer === null) return 'deny';
        const a = answer.trim().toLowerCase();
        if (a === 'y' || a === 'yes') return 'allow_once';
        if (a === 'a' || a === 'always') return 'allow_always';
        if (a === 'n' || a === 'no' || a === '') return 'deny';
      }
    };
    const next = chain.then(ask, ask);
    chain = next.catch(() => undefined);
    return next;
  };
}
