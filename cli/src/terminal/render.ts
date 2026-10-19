/**
 * Renders runtime events as plain terminal output: streamed root-agent text,
 * one concise line per tool call, child invocation status and errors.
 * All untrusted text (model output, tool output, MCP errors) is stripped of
 * terminal control sequences before printing.
 */

import { AgentTerminateMode, stripAnsiAndControl, type RuntimeEvent } from '@sfagents/core';
import { createStyle, type Style } from './style.js';

export interface RenderOptions {
  /** Where the root agent's streamed answer goes. */
  out: NodeJS.WritableStream;
  /** Where activity lines go (stderr for `run`, stdout for `start`). */
  activity: NodeJS.WritableStream;
  showReasoning?: boolean;
  /** Print one line per turn describing the working context (estimates). */
  showContext?: boolean;
}

function oneLine(text: string, max = 160): string {
  const flat = stripAnsiAndControl(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class EventRenderer {
  private readonly outStyle: Style;
  private readonly actStyle: Style;
  /** Whether the answer stream is mid-line (needs a newline before activity). */
  private midLine = false;
  private reasoningOpen = false;

  constructor(private readonly options: RenderOptions) {
    this.outStyle = createStyle(options.out as NodeJS.WriteStream);
    this.actStyle = createStyle(options.activity as NodeJS.WriteStream);
  }

  /** Ends a partially written answer line before other output. */
  breakLine(): void {
    if (this.midLine) {
      this.options.out.write('\n');
      this.midLine = false;
    }
    if (this.reasoningOpen) {
      this.options.activity.write('\n');
      this.reasoningOpen = false;
    }
  }

  private activityLine(depth: number, text: string): void {
    this.breakLine();
    this.options.activity.write(`${'  '.repeat(depth)}${text}\n`);
  }

  handle(event: RuntimeEvent): void {
    const depth = event.agentPath.length - 1;
    const s = this.actStyle;
    const who = depth > 0 ? s.magenta(`[${event.agentPath[event.agentPath.length - 1]}] `) : '';
    switch (event.type) {
      case 'text': {
        if (depth > 0) return; // children report through their result
        if (this.reasoningOpen) {
          this.options.activity.write('\n');
          this.reasoningOpen = false;
        }
        const text = stripAnsiAndControl(event.text);
        this.options.out.write(text);
        if (text.length > 0) this.midLine = !text.endsWith('\n');
        return;
      }
      case 'reasoning': {
        if (!this.options.showReasoning) return;
        if (this.midLine) this.breakLine();
        if (!this.reasoningOpen) {
          this.options.activity.write(`${'  '.repeat(depth)}${who}${s.dim('thinking: ')}`);
          this.reasoningOpen = true;
        }
        this.options.activity.write(s.dim(stripAnsiAndControl(event.text).replace(/\n/g, ' ')));
        return;
      }
      case 'tool_request':
        if (event.name === 'invoke_child') return; // shown by agent_start
        this.activityLine(depth, `${who}${s.cyan('⚙')} ${s.bold(event.name)} ${s.dim(oneLine(event.description))}`);
        return;
      case 'tool_result':
        if (event.name === 'invoke_child') return; // shown by agent_end
        this.activityLine(
          depth,
          `${who}${event.ok ? s.green('  ✓') : s.red('  ✗')} ${s.dim(oneLine(event.display || (event.ok ? 'done' : 'failed')))}`,
        );
        return;
      case 'agent_start':
        if (depth === 0) return;
        this.activityLine(depth - 1, `${s.magenta('↳')} ${s.bold(event.agentPath[depth]!)} ${s.dim(`started: ${oneLine(event.task, 120)}`)}`);
        return;
      case 'agent_end': {
        if (depth === 0) return;
        const r = event.result;
        const ok = r.status === AgentTerminateMode.GOAL;
        const summary = `${r.status === AgentTerminateMode.GOAL ? 'completed' : r.status.toLowerCase()} in ${(r.durationMs / 1000).toFixed(1)}s, ${r.turns} turn${r.turns === 1 ? '' : 's'}, ${r.toolCalls.length} tool call${r.toolCalls.length === 1 ? '' : 's'}`;
        this.activityLine(depth - 1, `${s.magenta('↳')} ${s.bold(event.agentPath[depth]!)} ${ok ? s.green(summary) : s.red(summary)}${r.error ? s.dim(` (${oneLine(r.error, 120)})`) : ''}`);
        return;
      }
      case 'context':
        if (!this.options.showContext || depth > 0) return;
        this.activityLine(
          depth,
          s.dim(
            `context: ~${event.estimatedTokens.toLocaleString('en-US')} of ${event.budget.toLocaleString('en-US')} est. tokens · ${event.includedExchanges} recent exchange(s)${event.omittedExchanges ? `, ${event.omittedExchanges} older not sent` : ''} · section index ${event.indexEntries}/${event.indexTotal}`,
          ),
        );
        return;
      case 'warning':
        this.activityLine(depth, `${who}${s.yellow('warning:')} ${oneLine(event.message, 400)}`);
        return;
      case 'error':
        this.activityLine(depth, `${who}${s.red('error:')} ${oneLine(event.message, 600)}`);
        return;
    }
  }

  get style(): Style {
    return this.outStyle;
  }
}
