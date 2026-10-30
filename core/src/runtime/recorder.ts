/**
 * Persistence hook for one agent run. The runtime calls it at the points
 * where messages are actually accepted or completed; the conversation
 * service implements it. Every method writes durably before returning and
 * throws (ConversationStorageError) when it cannot, in which case the
 * runtime stops before any further side effect.
 */

import type { AgentNode } from '../agents/loader.js';
import type { AssistantMessage, ToolMessage } from '../providers/types.js';
import type { AttachmentRef, ToolMessageStatus } from '../conversation/types.js';
import type { AgentRunResult } from './events.js';

export interface RunRecorder {
  readonly runId: string;
  /** The task or user input that starts this run, with any attached files and the message it replies to inline. */
  user(content: string, attachments?: AttachmentRef[], replyTo?: string): void;
  /** Run start with the configuration in effect (provenance only). */
  start(node: AgentNode): void;
  /** A complete assistant message (never a streaming fragment). */
  assistant(message: AssistantMessage, finishReason: string | null): void;
  /** Execution of an approved tool call is about to begin. */
  toolStart(callId: string, tool: string): void;
  /** The full tool message returned to the model, and how the call ended. */
  toolResult(message: ToolMessage, tool: string, status: ToolMessageStatus): void;
  end(result: AgentRunResult): void;
}

/** Thrown when a recorder write fails; the runtime stops the run. */
export class PersistenceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceFailure';
  }
}
