/**
 * Simple interactive conversation (`sfagents start`). Replaces upstream's
 * Ink/React TUI with readline: streamed answers, tool and child activity
 * lines, permission prompts, Ctrl+C to cancel a running turn, and ordinary
 * in-process context for follow-up messages.
 */

import readline from 'node:readline';
import { AgentTerminateMode, describeTree, type AgentRuntime, type ConfirmationHandler } from '@sfagents/core';
import { EventRenderer } from './render.js';
import { createTerminalConfirm } from './confirm.js';
import { createStyle } from './style.js';

export interface ReplOptions {
  runtime: AgentRuntime;
  showReasoning: boolean;
  /** Receives the terminal confirmation handler once readline exists. */
  bindConfirm?: (handler: ConfirmationHandler) => void;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const HELP = `Commands:
  /help    show this help
  /tree    show the agent tree
  /clear   start a new conversation (forget context)
  /exit    quit (or Ctrl+D)
Press Ctrl+C while the agent is working to cancel the current turn.`;

export async function startRepl(options: ReplOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const style = createStyle(output as NodeJS.WriteStream);
  const interactive = (input as NodeJS.ReadStream).isTTY === true && (output as NodeJS.WriteStream).isTTY === true;
  const rl = readline.createInterface({ input, output, terminal: interactive });
  const renderer = new EventRenderer({ out: output, activity: output, showReasoning: options.showReasoning });
  options.bindConfirm?.(createTerminalConfirm(rl, output, renderer));

  let session = options.runtime.createSession();
  const root = options.runtime.tree.root;
  output.write(
    `${style.bold('SF Agents')} ${style.dim(`— root agent "${root.id}" (${root.definition.provider}:${root.definition.model})`)}\n${style.dim('Type /help for commands.')}\n`,
  );

  let current: AbortController | undefined;
  let lastInterrupt = 0;
  let closed = false;

  return new Promise<number>((resolve) => {
    const prompt = () => {
      if (closed || inputEnded) return;
      rl.setPrompt(style.cyan('you> '));
      rl.prompt();
    };

    let inputEnded = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      resolve(0);
    };
    const quitNow = () => {
      current?.abort(new Error('quit'));
      queue.length = 0;
      finish();
      rl.close();
    };

    rl.on('SIGINT', () => {
      if (current) {
        const now = Date.now();
        if (now - lastInterrupt < 1500) {
          output.write('\nForce quit.\n');
          quitNow();
          return;
        }
        lastInterrupt = now;
        renderer.breakLine();
        output.write(style.yellow('Cancelling… (press Ctrl+C again to quit)\n'));
        current.abort(new Error('cancelled by user'));
      } else {
        output.write('\n');
        quitNow();
      }
    });

    // End of input (Ctrl+D or the end of piped stdin): finish queued work, then exit.
    rl.on('close', () => {
      inputEnded = true;
      if (!current && !draining) finish();
    });

    const queue: string[] = [];
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      while (queue.length > 0 && !closed) {
        const line = queue.shift()!.trim();
        if (!line) {
          prompt();
          continue;
        }
        if (line === '/exit' || line === '/quit') {
          queue.length = 0;
          finish();
          rl.close();
          break;
        }
        if (line === '/help') {
          output.write(`${HELP}\n`);
          prompt();
          continue;
        }
        if (line === '/tree') {
          output.write(`${describeTree(options.runtime.tree)}\n`);
          prompt();
          continue;
        }
        if (line === '/clear') {
          session = options.runtime.createSession();
          output.write(style.dim('Started a new conversation.\n'));
          prompt();
          continue;
        }
        if (!interactive) output.write(`${line}\n`);
        current = new AbortController();
        try {
          const result = await session.run(line, { signal: current.signal, onEvent: (e) => renderer.handle(e) });
          renderer.breakLine();
          if (result.status !== AgentTerminateMode.GOAL) {
            output.write(style.red(`[${result.status.toLowerCase()}] ${result.error ?? ''}\n`));
          } else if (result.error) {
            output.write(style.yellow(`[note] ${result.error}\n`));
          }
        } catch (error) {
          renderer.breakLine();
          output.write(style.red(`error: ${error instanceof Error ? error.message : String(error)}\n`));
        } finally {
          current = undefined;
        }
        prompt();
      }
      draining = false;
      if (inputEnded) finish();
    };

    rl.on('line', (line) => {
      if (closed) return;
      queue.push(line);
      if (current && interactive) output.write(style.dim('(queued — it will be sent after the current turn; Ctrl+C cancels the turn)\n'));
      void drain();
    });

    prompt();
  });
}
