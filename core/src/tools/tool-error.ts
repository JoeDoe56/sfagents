/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/utils/tool-error-type.ts
 * and tools/tool-error.ts, reduced to the codes the retained tools emit.
 */

/**
 * A type-safe enum for tool-related errors.
 */
export enum ToolErrorType {
  INVALID_TOOL_PARAMS = 'invalid_tool_params',
  UNHANDLED_EXCEPTION = 'unhandled_exception',
  TOOL_NOT_REGISTERED = 'tool_not_registered',
  EXECUTION_FAILED = 'execution_failed',
  EXECUTION_TIMEOUT = 'execution_timeout',
  EXECUTION_DENIED = 'execution_denied',
  EXECUTION_CANCELLED = 'execution_cancelled',

  FILE_NOT_FOUND = 'file_not_found',
  FILE_WRITE_FAILURE = 'file_write_failure',
  READ_CONTENT_FAILURE = 'read_content_failure',
  ATTEMPT_TO_CREATE_EXISTING_FILE = 'attempt_to_create_existing_file',
  FILE_TOO_LARGE = 'file_too_large',
  TARGET_IS_DIRECTORY = 'target_is_directory',
  PATH_NOT_IN_WORKSPACE = 'path_not_in_workspace',
  PATH_PROTECTED = 'path_protected',
  SEARCH_PATH_NOT_FOUND = 'search_path_not_found',
  PATH_IS_NOT_A_DIRECTORY = 'path_is_not_a_directory',

  EDIT_NO_OCCURRENCE_FOUND = 'edit_no_occurrence_found',
  EDIT_EXPECTED_OCCURRENCE_MISMATCH = 'edit_expected_occurrence_mismatch',
  EDIT_NO_CHANGE = 'edit_no_change',

  GLOB_EXECUTION_ERROR = 'glob_execution_error',
  GREP_EXECUTION_ERROR = 'grep_execution_error',
  LS_EXECUTION_ERROR = 'ls_execution_error',
  SHELL_EXECUTE_ERROR = 'shell_execute_error',
  MCP_TOOL_ERROR = 'mcp_tool_error',
  CHILD_AGENT_ERROR = 'child_agent_error',
  CONVERSATION_OPERATION_ERROR = 'conversation_operation_error',
}
