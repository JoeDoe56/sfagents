/** SF Agents' Git workspaces, run in the Git helper container. */

import { containerManager } from '../container/containers.js';
import { gitIdentityEnv } from '../tools/shell.js';
import { GitWorkspaces } from './workspaces.js';

export function defaultGitWorkspaces(o: { onChange?: () => void } = {}): GitWorkspaces {
  return new GitWorkspaces({
    run: (script, opts) => containerManager().runGit(script, opts),
    identity: gitIdentityEnv,
    ...(o.onChange ? { onChange: o.onChange } : {}),
  });
}
