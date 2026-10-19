/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted for SF Agents from qwen-code packages/core/src/tools/grep.ts.
 * Keeps the git grep → system grep → JavaScript strategy order, the
 * null-delimited output parser, the git no-exec hardening (from
 * utils/gitUtils.ts), output grouping and truncation. Changes: on Windows
 * only the JavaScript strategy runs (bare command lookup there can resolve
 * executables from the working directory); every matched file is re-checked
 * against the agent's canonical roots; outside paths are denied.
 */

import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { globStream } from 'glob';
import type { ToolInvocation, ToolResult, PermissionDecision } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolContext } from './tool-context.js';
import { DEFAULT_IGNORES } from './glob.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debug.js';

const debugLogger = createDebugLogger('GREP');
const DEFAULT_LINE_LIMIT = 500;

/**
 * Repository config can name programs git runs implicitly (core.fsmonitor on
 * index refresh, gpg.program via log.showSignature). Disable both on every
 * git call so searching an untrusted repository cannot execute code.
 */
const NO_EXEC_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'log.showSignature=false'];

export interface GrepToolParams {
  pattern: string;
  path?: string;
  glob?: string;
  limit?: number;
}

interface GrepMatch {
  filePath: string;
  absoluteFilePath: string;
  lineNumber: number;
  line: string;
}

const commandAvailability = new Map<string, boolean>();
function isCommandAvailable(command: string): boolean {
  if (commandAvailability.has(command)) return commandAvailability.get(command)!;
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
  const ok = result.error === undefined && result.status === 0;
  commandAvailability.set(command, ok);
  return ok;
}

function isGitRepository(directory: string): boolean {
  let currentDir = path.resolve(directory);
  while (true) {
    if (fs.existsSync(path.join(currentDir, '.git'))) return true;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return false;
    currentDir = parentDir;
  }
}

class GrepToolInvocation extends BaseToolInvocation<GrepToolParams, ToolResult> {
  constructor(
    private readonly ctx: ToolContext,
    params: GrepToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const displayPath = this.params.path
      ? this.ctx.workspace.display(this.ctx.workspace.resolve(this.params.path))
      : '.';
    let description = `'${this.params.pattern}' in ${displayPath}`;
    if (this.params.glob) description += ` (filter: '${this.params.glob}')`;
    return description;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (!this.params.path) return 'allow';
    const check = this.ctx.workspace.check(this.params.path, 'read');
    if (!check.ok) {
      this.denialReason = check.reason;
      return 'deny';
    }
    return 'allow';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const searchDirs: string[] = [];
      let searchLocationDescription: string;
      if (this.params.path) {
        const check = this.ctx.workspace.check(this.params.path, 'read');
        if (!check.ok || !check.resolvedPath) {
          const message = check.reason ?? 'Path not permitted';
          return { llmContent: message, returnDisplay: message, error: { message, type: ToolErrorType.PATH_NOT_IN_WORKSPACE } };
        }
        searchDirs.push(check.resolvedPath);
        searchLocationDescription = `in path "${this.params.path}"`;
      } else {
        const dirs = this.ctx.workspace.getDirectories();
        searchDirs.push(...dirs);
        searchLocationDescription = dirs.length > 1 ? `across ${dirs.length} workspace directories` : 'in the workspace directory';
      }

      const permittedFile = new Map<string, boolean>();
      const isPermitted = (absolute: string) => {
        let ok = permittedFile.get(absolute);
        if (ok === undefined) {
          ok = this.ctx.workspace.check(absolute, 'read').ok;
          permittedFile.set(absolute, ok);
        }
        return ok;
      };

      let rawMatches: GrepMatch[] = [];
      for (const searchDir of searchDirs) {
        let matches: GrepMatch[];
        const stat = await fsPromises.stat(searchDir);
        if (stat.isFile()) {
          matches = await this.searchSingleFile(searchDir);
        } else {
          matches = await this.performGrepSearch(this.params.pattern, searchDir, this.params.glob, signal);
        }
        for (const match of matches) {
          if (!isPermitted(match.absoluteFilePath)) continue;
          if (searchDirs.length > 1) match.filePath = match.absoluteFilePath;
          rawMatches.push(match);
        }
      }
      if (searchDirs.length > 1) {
        const seen = new Set<string>();
        rawMatches = rawMatches.filter((m) => {
          const key = `${m.absoluteFilePath}:${m.lineNumber}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      const filterDescription = this.params.glob ? ` (filter: "${this.params.glob}")` : '';
      if (rawMatches.length === 0) {
        return {
          llmContent: `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`,
          returnDisplay: 'No matches found',
        };
      }

      const charLimit = this.ctx.maxOutputChars;
      const lineLimit = Math.min(DEFAULT_LINE_LIMIT, this.params.limit ?? Number.POSITIVE_INFINITY);
      const truncatedByLineLimit = rawMatches.length > lineLimit;
      const matchesToInclude = truncatedByLineLimit ? rawMatches.slice(0, lineLimit) : rawMatches;
      const totalMatches = rawMatches.length;
      const matchTerm = totalMatches === 1 ? 'match' : 'matches';
      const header = `Found ${totalMatches} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}:\n---\n`;

      const matchesByFile = new Map<string, GrepMatch[]>();
      for (const match of matchesToInclude) {
        const list = matchesByFile.get(match.filePath) ?? [];
        list.push(match);
        matchesByFile.set(match.filePath, list);
      }

      let grepOutput = '';
      let includedLines = 0;
      let truncatedByCharLimit = false;
      const appendChunk = (chunk: string, isMatch: boolean): boolean => {
        if (grepOutput.length + chunk.length > charLimit) {
          grepOutput += chunk.slice(0, Math.max(charLimit - grepOutput.length, 0)) + '...';
          truncatedByCharLimit = true;
          return false;
        }
        grepOutput += chunk;
        if (isMatch) includedLines++;
        return true;
      };
      outer: for (const [filePath, fileMatches] of matchesByFile) {
        fileMatches.sort((a, b) => a.lineNumber - b.lineNumber);
        if (!appendChunk(`File: ${filePath}\n`, false)) break;
        for (const match of fileMatches) {
          if (!appendChunk(`L${match.lineNumber}: ${match.line.trim()}\n`, true)) break outer;
        }
        if (!appendChunk('---\n', false)) break;
      }

      let llmContent = header + grepOutput;
      if (truncatedByLineLimit || truncatedByCharLimit) {
        const omitted = totalMatches - includedLines;
        llmContent += ` [${omitted} ${omitted === 1 ? 'line' : 'lines'} truncated] ...`;
      }
      return {
        llmContent: llmContent.trim(),
        returnDisplay: `Found ${totalMatches} ${matchTerm}${truncatedByLineLimit || truncatedByCharLimit ? ' (truncated)' : ''}`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: { message: errorMessage, type: ToolErrorType.GREP_EXECUTION_ERROR },
      };
    }
  }

  private async searchSingleFile(filePath: string): Promise<GrepMatch[]> {
    const regex = new RegExp(this.params.pattern, 'i');
    const content = await fsPromises.readFile(filePath, 'utf8');
    const matches: GrepMatch[] = [];
    content.split(/\r?\n/).forEach((line, index) => {
      if (regex.test(line)) {
        matches.push({ filePath: path.basename(filePath), absoluteFilePath: filePath, lineNumber: index + 1, line });
      }
    });
    return matches;
  }

  /**
   * Parses null-delimited output of `git grep -z -n` (path\0line\0content)
   * and `grep --null -n` (path\0line:content), with a colon-delimited
   * fallback.
   */
  private parseGrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;
    const pushMatch = (filePathRaw: string, lineNumberStr: string, lineContent: string) => {
      const lineNumber = parseInt(lineNumberStr, 10);
      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);
        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          absoluteFilePath,
          lineNumber,
          line: lineContent.replace(/\r$/, ''),
        });
      }
    };

    if (output.includes('\0')) {
      let index = 0;
      while (index < output.length) {
        const pathEnd = output.indexOf('\0', index);
        if (pathEnd === -1) break;
        const nextNewline = output.indexOf('\n', index);
        if (nextNewline !== -1 && nextNewline < pathEnd) {
          index = nextNewline + 1;
          continue;
        }
        const filePathRaw = output.substring(index, pathEnd);
        const afterPath = pathEnd + 1;
        const nextNull = output.indexOf('\0', afterPath);
        let lineEnd = output.indexOf('\n', afterPath);
        if (lineEnd === -1) lineEnd = output.length;
        if (nextNull !== -1 && nextNull < lineEnd) {
          const lineNumberStr = output.substring(afterPath, nextNull);
          let contentEnd = output.indexOf('\n', nextNull + 1);
          if (contentEnd === -1) contentEnd = output.length;
          pushMatch(filePathRaw, lineNumberStr, output.substring(nextNull + 1, contentEnd));
          index = contentEnd + 1;
          continue;
        }
        const rest = output.substring(afterPath, lineEnd);
        const separator = rest.indexOf(':');
        if (separator !== -1) {
          pushMatch(filePathRaw, rest.substring(0, separator), rest.substring(separator + 1));
        }
        index = lineEnd + 1;
      }
      return results;
    }

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const match = line.replace(/\r$/, '').match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      pushMatch(match[1]!, match[2]!, match[3]!);
    }
    return results;
  }

  private runSearchProcess(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, signal });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (!text.includes('Permission denied') && !/grep:.*: Is a directory/i.test(text)) {
          stderrChunks.push(chunk);
        }
      });
      child.on('error', (err) => reject(new Error(`Failed to start ${command}: ${err.message}`)));
      child.on('close', (code) => {
        const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
        if (code === 0) resolve(stdoutData);
        else if (code === 1) resolve('');
        else reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').trim()}`));
      });
    });
  }

  private async performGrepSearch(
    pattern: string,
    absolutePath: string,
    glob: string | undefined,
    signal: AbortSignal,
  ): Promise<GrepMatch[]> {
    // SFAGENTS_GREP_JS=1 forces the JavaScript strategy (the only one used on Windows).
    const allowExternalCommands = process.platform !== 'win32' && process.env['SFAGENTS_GREP_JS'] !== '1';

    if (allowExternalCommands && isGitRepository(absolutePath) && isCommandAvailable('git')) {
      const gitArgs = [...NO_EXEC_CONFIG, 'grep', '--untracked', '-n', '-z', '-E', '--ignore-case', '-e', pattern];
      if (glob) gitArgs.push('--', glob);
      try {
        return this.parseGrepOutput(await this.runSearchProcess('git', gitArgs, absolutePath, signal), absolutePath);
      } catch (gitError) {
        if (signal.aborted) throw gitError;
        debugLogger.debug(`git grep failed: ${getErrorMessage(gitError)}. Falling back...`);
      }
    }

    if (allowExternalCommands && isCommandAvailable('grep')) {
      const grepArgs = ['-r', '-n', '-H', '-E', '-i', '--null', '--exclude-dir=node_modules', '--exclude-dir=.git'];
      if (glob) grepArgs.push(`--include=${glob}`);
      grepArgs.push('-e', pattern, '.');
      try {
        return this.parseGrepOutput(await this.runSearchProcess('grep', grepArgs, absolutePath, signal), absolutePath);
      } catch (grepError) {
        if (signal.aborted) throw grepError;
        debugLogger.debug(`system grep failed: ${getErrorMessage(grepError)}. Falling back...`);
      }
    }

    const filesIterator = globStream(glob ? glob : '**/*', {
      cwd: absolutePath,
      // Match basename filters such as *.txt at every depth, like recursive grep.
      matchBase: true,
      dot: true,
      ignore: DEFAULT_IGNORES,
      absolute: true,
      nodir: true,
      follow: false,
      signal,
    });
    const regex = new RegExp(pattern, 'i');
    const allMatches: GrepMatch[] = [];
    for await (const filePath of filesIterator) {
      const fileAbsolutePath = filePath as string;
      try {
        const stats = await fsPromises.stat(fileAbsolutePath);
        if (stats.size > 5 * 1024 * 1024) continue;
        const content = await fsPromises.readFile(fileAbsolutePath, 'utf8');
        if (content.includes('\0')) continue;
        content.split(/\r?\n/).forEach((line, index) => {
          if (regex.test(line)) {
            allMatches.push({
              filePath: path.relative(absolutePath, fileAbsolutePath) || path.basename(fileAbsolutePath),
              absoluteFilePath: fileAbsolutePath,
              lineNumber: index + 1,
              line,
            });
          }
        });
      } catch {
        // Unreadable files are skipped, as upstream does.
      }
    }
    return allMatches;
  }
}

export class GrepTool extends BaseDeclarativeTool<GrepToolParams, ToolResult> {
  static readonly Name = ToolNames.GREP;

  constructor(private readonly ctx: ToolContext) {
    super(
      GrepTool.Name,
      'Grep',
      'Searches file contents for a regular expression (case-insensitive). Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Filter files with the glob parameter (e.g. "*.js", "**/*.tsx"). Prefer this over running grep through a shell.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
          glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
          path: {
            type: 'string',
            description: 'File or directory to search in. Absolute, or relative to the primary workspace root. Defaults to all workspace roots.',
          },
          limit: { type: 'integer', minimum: 1, description: 'Limit output to the first N matching lines.' },
        },
        required: ['pattern'],
      },
    );
  }

  protected override validateToolParamValues(params: GrepToolParams): string | null {
    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }
    if (params.glob && (path.isAbsolute(params.glob) || params.glob.split(/[\\/]/).includes('..'))) {
      return "The 'glob' filter must be relative and must not contain '..'.";
    }
    return null;
  }

  protected createInvocation(params: GrepToolParams): ToolInvocation<GrepToolParams, ToolResult> {
    return new GrepToolInvocation(this.ctx, params);
  }
}
