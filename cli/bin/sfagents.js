#!/usr/bin/env node
// Stable entry point so npm can link the `sfagents` command before the
// TypeScript build output exists. Run `npm run build` (or `npm install`,
// which builds through the root `prepare` script) to create cli/dist.
import('../dist/index.js').catch((error) => {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write('SF Agents is not built yet. Run "npm run build" in the repository root.\n');
    process.exit(1);
  }
  throw error;
});
