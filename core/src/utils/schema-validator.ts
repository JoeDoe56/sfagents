/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/utils/schemaValidator.ts.
 * Keeps draft-07 / draft-2020-12 selection, lenient handling of unknown
 * keywords and formats, and fail-open behavior for schemas Ajv cannot
 * compile (MCP servers still validate their own input). The upstream
 * text-keyed compile cache is replaced by a WeakMap.
 */

import AjvPkg, { type AnySchema, type Ajv, type ValidateFunction } from 'ajv';
// Ajv2020 is the documented way to use draft-2020-12.
import Ajv2020Pkg from 'ajv/dist/2020.js';
import * as addFormats from 'ajv-formats';
import { createDebugLogger } from './debug.js';

// Ajv's ESM/CJS interop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvClass = (AjvPkg as any).default || AjvPkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Class = (Ajv2020Pkg as any).default || Ajv2020Pkg;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormatsFunc = (addFormats as any).default || addFormats;

const debugLogger = createDebugLogger('SchemaValidator');

const ajvOptions = {
  // The JSON Schema spec allows non-standard keywords; ignore them.
  strictSchema: false,
  // Models sometimes send "5" for an integer; coerce simple scalar types.
  coerceTypes: true,
  allErrors: false,
  logger: {
    log: () => {},
    warn: () => {},
    error: (...args: unknown[]) => debugLogger.error(...args),
  },
};

const ajvDefault: Ajv = new AjvClass(ajvOptions);
const ajv2020: Ajv = new Ajv2020Class(ajvOptions);
addFormatsFunc(ajvDefault);
addFormatsFunc(ajv2020);

const DRAFT_2020_12_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

function isDraft2020Uri(uri: unknown): boolean {
  if (typeof uri !== 'string') return false;
  const normalized = uri.endsWith('#') ? uri.slice(0, -1) : uri;
  return normalized === DRAFT_2020_12_SCHEMA;
}

function getValidator(schema: AnySchema): Ajv {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    '$schema' in schema &&
    isDraft2020Uri(schema.$schema)
  ) {
    return ajv2020;
  }
  return ajvDefault;
}

const compiled = new WeakMap<object, ValidateFunction | null>();

function compile(schema: object): ValidateFunction | null {
  if (compiled.has(schema)) return compiled.get(schema) ?? null;
  let validate: ValidateFunction | null = null;
  try {
    validate = getValidator(schema as AnySchema).compile(schema as AnySchema);
  } catch (error) {
    debugLogger.warn(
      `Failed to compile schema: ${error instanceof Error ? error.message : String(error)}. Skipping parameter validation.`,
    );
  }
  compiled.set(schema, validate);
  return validate;
}

export class SchemaValidator {
  /**
   * Validates tool parameters. Returns an error message, or null when the
   * data is valid or the schema cannot be compiled.
   */
  static validate(schema: unknown, data: unknown): string | null {
    if (!schema || typeof schema !== 'object') {
      return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return 'Value of params must be an object';
    }
    const validate = compile(schema);
    if (!validate) return null;
    if (validate(data)) return null;
    const validator = getValidator(schema as AnySchema);
    return validator.errorsText(validate.errors, { dataVar: 'params' });
  }
}
