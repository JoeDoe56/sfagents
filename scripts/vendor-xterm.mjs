#!/usr/bin/env node
// Copies xterm.js (MIT) and its fit and web-links addons into
// web/public/vendor/xterm for the terminal. Run after changing their versions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'web', 'public', 'vendor', 'xterm');
const mod = (p) => path.join(root, 'node_modules', p);
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const copy = (from, to) => fs.copyFileSync(mod(from), path.join(target, to));
copy('@xterm/xterm/lib/xterm.mjs', 'xterm.mjs');
copy('@xterm/xterm/css/xterm.css', 'xterm.css');
copy('@xterm/addon-fit/lib/addon-fit.mjs', 'addon-fit.mjs');
copy('@xterm/addon-web-links/lib/addon-web-links.mjs', 'addon-web-links.mjs');
copy('@xterm/xterm/LICENSE', 'LICENSE');
// Source maps are not shipped.
for (const f of fs.readdirSync(target)) {
  if (f.endsWith('.mjs')) fs.writeFileSync(path.join(target, f), fs.readFileSync(path.join(target, f), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, ''));
}
const versions = ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'].map((n) => `${n} ${JSON.parse(fs.readFileSync(mod(`${n}/package.json`), 'utf8')).version}`);
fs.writeFileSync(path.join(target, 'README.md'), `# Vendored xterm.js\n\nCopied by \`scripts/vendor-xterm.mjs\` (MIT, see LICENSE): ${versions.join(', ')}.\n`);
console.log(`Vendored ${versions.join(', ')} into ${path.relative(root, target)}`);
