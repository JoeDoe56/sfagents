/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code
 * packages/core/src/utils/sanitize-child-env.ts and utils/windowsPath.ts.
 * The secret list is supplied by the runtime (provider API key variables)
 * instead of Qwen's daemon tokens; PATH merging is simplified.
 */

/** Variable names always removed from child processes. */
export const ALWAYS_STRIPPED_ENV_VARS: readonly string[] = ['OPENROUTER_API_KEY', 'SFAGENTS_API_KEY'];

/**
 * Returns a copy of `env` without runtime secrets, so shell commands and
 * stdio MCP servers do not inherit the model provider's API key.
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv,
  secretNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const blocked = new Set([...ALWAYS_STRIPPED_ENV_VARS, ...secretNames].map((n) => n.toUpperCase()));
  // Spread + delete keeps an own `__proto__` key as a plain property.
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (blocked.has(key.toUpperCase())) delete sanitized[key];
  }
  return normalizePathEnvForWindows(sanitized);
}

/**
 * On Windows, environment keys are case-insensitive but a JS object can hold
 * both `Path` and `PATH`; a child then sees an arbitrary one. Merge all
 * variants into a single `PATH`, preserving order and removing duplicates.
 */
export function normalizePathEnvForWindows(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env;
  const normalized: NodeJS.ProcessEnv = { ...env };
  const pathKeys = Object.keys(normalized).filter((key) => key.toLowerCase() === 'path');
  if (pathKeys.length <= 1) return normalized;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const key of pathKeys.sort((a, b) => (a === 'Path' ? -1 : b === 'Path' ? 1 : 0))) {
    for (const entry of (normalized[key] ?? '').split(';')) {
      const k = entry.toLowerCase();
      if (entry && !seen.has(k)) {
        seen.add(k);
        merged.push(entry);
      }
    }
    delete normalized[key];
  }
  normalized['PATH'] = merged.join(';');
  return normalized;
}
