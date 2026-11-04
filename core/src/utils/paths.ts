import fs from 'node:fs';
import path from 'node:path';

/** Whether @p pathToCheck is @p rootDirectory or inside it (both absolute). */
export function isPathWithinRoot(pathToCheck: string, rootDirectory: string): boolean {
  const relative = path.relative(rootDirectory, pathToCheck);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * The canonical path of @p p with symbolic links followed: the file itself
 * when it exists, else its nearest existing folder joined with the rest. So a
 * link inside an allowed folder that points elsewhere is judged by where it
 * points.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let at = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...missing.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return abs;
      missing.push(path.basename(at));
      at = parent;
    }
  }
}
