/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/tools.ts.
 * Keeps the declarative tool / invocation contract, `ToolResult`, `Kind`,
 * permission decisions and confirmation details. Removed: genai types, media
 * policy, artifacts, MCP apps, advisor/team/findings displays, deferred tool
 * search and the auto-mode classifier projection.
 */

import { ToolErrorType } from './tool-error.js';
import { SchemaValidator } from '../utils/schema-validator.js';

/** A JSON Schema object describing a tool's parameters. */
export type JsonSchema = Record<string, unknown>;

/** The model-facing declaration of a tool (OpenAI `function` shape). */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * The tool's intrinsic permission for one invocation:
 * - `allow`: inherently safe (read-only, inside the workspace).
 * - `ask`: has side effects; needs approval unless auto-approved.
 * - `deny`: policy violation; never executed.
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * Represents a validated and ready-to-execute tool call.
 * An instance of this is created by a `ToolBuilder`.
 */
export interface ToolInvocation<
  TParams extends object,
  TResult extends ToolResult,
> {
  /** The validated parameters for this specific invocation. */
  params: TParams;

  /** A short pre-execution description of what the tool will do. */
  getDescription(): string;

  /** The file system paths the tool will affect. */
  toolLocations(): ToolLocation[];

  /**
   * The tool's intrinsic permission for this invocation, based solely on its
   * own parameters and the agent's workspace policy. A `deny` carries a reason
   * via {@link getDenialReason}.
   */
  getDefaultPermission(signal?: AbortSignal): Promise<PermissionDecision>;

  /** Explanation returned to the model when the permission is `deny`. */
  getDenialReason?(): string | undefined;

  /** Details for the confirmation prompt, used when approval is needed. */
  getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails>;

  /**
   * Executes the tool with the validated parameters.
   * @param signal AbortSignal for tool cancellation.
   * @param updateOutput Optional callback to stream output.
   */
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<TResult>;
}

/**
 * A convenience base class for ToolInvocation.
 */
export abstract class BaseToolInvocation<
  TParams extends object,
  TResult extends ToolResult,
> implements ToolInvocation<TParams, TResult>
{
  protected denialReason: string | undefined;

  constructor(readonly params: TParams) {}

  abstract getDescription(): string;

  toolLocations(): ToolLocation[] {
    return [];
  }

  /** Default: read-only tools return 'allow'. Override for side effects. */
  getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve('allow');
  }

  getDenialReason(): string | undefined {
    return this.denialReason;
  }

  /**
   * Default fallback: a generic 'info' confirmation using getDescription().
   * Tools with richer confirmation UIs (shell, edit, MCP) override this.
   */
  getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    return Promise.resolve({
      type: 'info',
      title: `Confirm ${this.constructor.name.replace(/Invocation$/, '')}`,
      prompt: this.getDescription(),
    });
  }

  abstract execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<TResult>;
}

/** A tool invocation whose parameter and result types are not known. */
export type AnyToolInvocation = ToolInvocation<object, ToolResult>;

/**
 * Interface for a tool builder that validates parameters and creates
 * invocations.
 */
export interface ToolBuilder<
  TParams extends object,
  TResult extends ToolResult,
> {
  /** The internal name of the tool (used for API calls). */
  name: string;
  /** The user-friendly display name of the tool. */
  displayName: string;
  /** Description of what the tool does. */
  description: string;
  /** The kind of tool for categorization and permissions. */
  kind: Kind;
  /** Function declaration sent to the model. */
  schema: FunctionDeclaration;
  /**
   * Validates raw parameters and builds a ready-to-execute invocation.
   * Throws if validation fails.
   */
  build(params: TParams): ToolInvocation<TParams, TResult>;
}

/**
 * Base class for tools that separates validation from execution.
 */
export abstract class DeclarativeTool<
  TParams extends object,
  TResult extends ToolResult,
> implements ToolBuilder<TParams, TResult>
{
  constructor(
    readonly name: string,
    readonly displayName: string,
    readonly description: string,
    readonly kind: Kind,
    readonly parameterSchema: JsonSchema,
  ) {}

  get schema(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameterSchema,
    };
  }

  /**
   * Validates the raw tool parameters. Subclasses override to add checks
   * beyond the JSON schema.
   * @returns An error message string if invalid, null otherwise.
   */
  validateToolParams(_params: TParams): string | null {
    return null;
  }

  abstract build(params: TParams): ToolInvocation<TParams, TResult>;

  /** Builds and executes in one step. Never throws. */
  async validateBuildAndExecute(
    params: TParams,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    let invocation: ToolInvocation<TParams, TResult>;
    try {
      invocation = this.build(params);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: { message: errorMessage, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    try {
      return await invocation.execute(abortSignal);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error: Tool call execution failed. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: { message: errorMessage, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

/**
 * Declarative tool whose `build` validates against the JSON schema and then
 * `validateToolParamValues` before creating the invocation.
 */
export abstract class BaseDeclarativeTool<
  TParams extends object,
  TResult extends ToolResult,
> extends DeclarativeTool<TParams, TResult> {
  build(params: TParams): ToolInvocation<TParams, TResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      throw new Error(validationError);
    }
    return this.createInvocation(params);
  }

  override validateToolParams(params: TParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }
    return this.validateToolParamValues(params);
  }

  protected validateToolParamValues(_params: TParams): string | null {
    return null;
  }

  protected abstract createInvocation(
    params: TParams,
  ): ToolInvocation<TParams, TResult>;
}

/** A declarative tool whose parameter and result types are not known. */
export type AnyDeclarativeTool = DeclarativeTool<object, ToolResult>;

export interface ToolResult {
  /**
   * Content sent back to the model as the tool response. Kept as text:
   * OpenAI-compatible tool messages are text.
   */
  llmContent: string;

  /** A short user-facing summary of the result. */
  returnDisplay: string;

  /** Present when the tool call failed. */
  error?: {
    message: string;
    type?: ToolErrorType;
  };

  /** Structured data for callers inside the runtime (not sent to the model). */
  metadata?: Record<string, unknown>;
}

export interface FileDiff {
  fileName: string;
  fileDiff: string;
}

export interface ToolEditConfirmationDetails {
  type: 'edit';
  title: string;
  fileName: string;
  filePath: string;
  fileDiff: string;
}

export interface ToolExecuteConfirmationDetails {
  type: 'exec';
  title: string;
  command: string;
  rootCommand: string;
  cwd: string;
}

export interface ToolMcpConfirmationDetails {
  type: 'mcp';
  title: string;
  serverName: string;
  toolName: string;
  toolDisplayName: string;
  args: Record<string, unknown>;
}

export interface ToolInfoConfirmationDetails {
  type: 'info';
  title: string;
  prompt: string;
}

export type ToolCallConfirmationDetails =
  | ToolEditConfirmationDetails
  | ToolExecuteConfirmationDetails
  | ToolMcpConfirmationDetails
  | ToolInfoConfirmationDetails;

export enum Kind {
  Read = 'read',
  Edit = 'edit',
  Delete = 'delete',
  Move = 'move',
  Search = 'search',
  Execute = 'execute',
  Think = 'think',
  Fetch = 'fetch',
  Delegate = 'delegate',
  Other = 'other',
}

/** Tool kinds whose invocations have side effects. */
export const MUTATOR_KINDS: Kind[] = [
  Kind.Edit,
  Kind.Delete,
  Kind.Move,
  Kind.Execute,
];

export interface ToolLocation {
  /** Absolute path to the file. */
  path: string;
  /** Which line (if known). */
  line?: number;
}
