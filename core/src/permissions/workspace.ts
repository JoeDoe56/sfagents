/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code
 * packages/core/src/utils/workspaceContext.ts. Keeps canonical (realpath)
 * containment checks, resolution of not-yet-existing paths through their
 * nearest existing ancestor, and rejection of dangling file symlinks.
 * Removed: change listeners and runtime add/remove of directories; an agent's
 * roots are fixed when its definition is loaded. Added: protected paths
 * (agent and MCP configuration files) that file tools may never modify, and
 * secret paths (the configuration .env) they may not read either.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNodeError } from '../utils/errors.js';

export type PathAccess = 'read' | 'write';

export interface PathCheck {
  ok: boolean;
  /** Canonical absolute path when resolvable. */
  resolvedPath?: string;
  reason?: string;
}

export class WorkspaceContext {
  private readonly directories: readonly string[];
  private readonly protectedPaths: ReadonlySet<string>;
  private readonly secretPaths: ReadonlySet<string>;

  /**
   * @param directories Absolute or relative root directories. Each must exist.
   * @param protectedPaths Files that may be read but never written by file tools.
   * @param secretPaths Files file tools may neither read nor write (credentials).
   */
  constructor(
    directories: readonly string[],
    protectedPaths: readonly string[] = [],
    secretPaths: readonly string[] = [],
  ) {
    if (directories.length === 0) {
      throw new Error('A workspace needs at least one root directory.');
    }
    this.directories = Object.freeze(
      directories.map((d) => WorkspaceContext.resolveAndValidateDir(d)),
    );
    this.protectedPaths = new Set(
      protectedPaths.map((p) => normalizeForCompare(resolveWorkspacePath(path.resolve(p)))),
    );
    this.secretPaths = new Set(
      secretPaths.map((p) => normalizeForCompare(resolveWorkspacePath(path.resolve(p)))),
    );
  }

  static resolveAndValidateDir(directory: string): string {
    const absolutePath = path.resolve(directory);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Directory does not exist: ${absolutePath}`);
    }
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }
    return fs.realpathSync(absolutePath);
  }

  /** Canonical root directories. The first one is the primary root. */
  getDirectories(): readonly string[] {
    return this.directories;
  }

  getPrimaryDirectory(): string {
    return this.directories[0]!;
  }

  /** Resolves a model-supplied path: relative paths are against the primary root. */
  resolve(p: string): string {
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.getPrimaryDirectory(), p);
  }

  /**
   * Checks if a path is within one of the workspace roots after resolving
   * symlinks, `..` segments and missing trailing components.
   */
  isPathWithinWorkspace(pathToCheck: string): boolean {
    return this.check(pathToCheck, 'read').ok;
  }

  /**
   * Full policy check for a file tool. `write` additionally refuses
   * protected configuration files.
   */
  check(pathToCheck: string, access: PathAccess): PathCheck {
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(this.resolve(pathToCheck));
    } catch (error) {
      return {
        ok: false,
        reason: `Path could not be resolved safely: ${pathToCheck} (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const inside = this.directories.some((dir) => isPathWithinRoot(resolved, dir));
    if (!inside) {
      return {
        ok: false,
        resolvedPath: resolved,
        reason: `Path is outside this agent's permitted workspace roots: ${pathToCheck}. Permitted roots: ${this.directories.join(', ')}`,
      };
    }
    if (this.secretPaths.has(normalizeForCompare(resolved))) {
      return {
        ok: false,
        resolvedPath: resolved,
        reason: `Path holds SF Agents credentials and is not accessible to agent file tools: ${pathToCheck}`,
      };
    }
    if (access === 'write' && this.protectedPaths.has(normalizeForCompare(resolved))) {
      return {
        ok: false,
        resolvedPath: resolved,
        reason: `Path is a protected SF Agents configuration file and cannot be modified by agent file tools: ${pathToCheck}`,
      };
    }
    return { ok: true, resolvedPath: resolved };
  }

  /** Path relative to the primary root for display, or the absolute path. */
  display(p: string): string {
    const primary = this.getPrimaryDirectory();
    const rel = path.relative(primary, p);
    if (rel === '') return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
    return rel;
  }
}

function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolves a path to its canonical form. Missing trailing components are
 * resolved through their nearest existing ancestor; a dangling symlink is an
 * error (it cannot be proven to stay inside a root).
 */
export function resolveWorkspacePath(pathToCheck: string): string {
  try {
    return fs.realpathSync(pathToCheck);
  } catch (error: unknown) {
    if (isResolvableMissingPathError(error)) {
      return resolveMissingPath(pathToCheck);
    }
    throw error;
  }
}

function resolveMissingPath(pathToCheck: string): string {
  const missingTail: string[] = [];
  let ancestor = pathToCheck;

  while (true) {
    try {
      const resolvedAncestor = fs.realpathSync(ancestor);
      return path.join(resolvedAncestor, ...missingTail);
    } catch (error: unknown) {
      if (!isResolvableMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return pathToCheck;
      }
      missingTail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function isResolvableMissingPathError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    error.code === 'ENOENT' &&
    !!error.path &&
    !isSymlink(error.path)
  );
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `pathToCheck` equals or is below `rootDirectory`. Both must be canonical. */
export function isPathWithinRoot(
  pathToCheck: string,
  rootDirectory: string,
): boolean {
  const relative = path.relative(rootDirectory, pathToCheck);
  return (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}
