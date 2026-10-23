#!/usr/bin/env node
/**
 * Copies the parts of sfgl the web client uses into web/public/vendor/sfgl:
 * the ES module sources, the Host Grotesk font, the licenses, and only the
 * SF Symbols glyphs listed below.
 *
 *   node scripts/vendor-sfgl.mjs [path to an sfgl checkout]   (default ../sfgl)
 *
 * sfgl is MIT-licensed. The SF Symbols glyphs are Apple's artwork and are
 * NOT covered by that license; see vendor/sfgl/symbols/PROVENANCE.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(root, '..', 'sfgl'));
const target = path.join(root, 'web', 'public', 'vendor', 'sfgl');

/** Glyphs the web client references (symbol names, not file names). */
export const GLYPHS = [
  'mic', 'mic.fill', 'plus', 'pin', 'pin.fill', 'pin.slash', 'arrow.up', 'xmark', 'xmark.circle.fill',
  'doc', 'doc.text', 'doc.richtext', 'doc.plaintext', 'chevron.left.slash.chevron.right', 'photo', 'globe',
  'chart.bar', 'list.bullet', 'stop.fill', 'checkmark', 'exclamationmark.triangle', 'paperclip', 'folder',
  'square.and.arrow.down', 'arrow.up.right.square', 'ellipsis', 'waveform', 'music.note', 'film',
  'archivebox', 'gauge', 'text.alignleft', 'scribble', 'gear',
  // Providers, apps and search
  'asterisk.circle', 'antenna.radiowaves.left.and.right', 'plus.circle.fill', 'macwindow', 'safari', 'keyboard', 'lock', 'link',
  'desktopcomputer', 'arrow.up.left.and.arrow.down.right', 'arrow.down',
  // Monitor windows and the file manager
  'speedometer', 'cube', 'rectangle.stack', 'tray.2.fill', 'wifi', 'sparkles', 'chevron.left', 'chevron.right', 'chevron.down', 'chevron.up', 'magnifyingglass', 'arrow.up.arrow.down', 'stop.circle', 'xmark.octagon', 'slider.horizontal.3', 'person.crop.circle', 'person.2', 'play.fill', 'arrow.clockwise', 'folder.fill', 'doc.fill', 'doc.text.fill', 'archivebox.fill', 'play.rectangle.fill', 'textformat', 'app', 'tray.full.fill', 'trash', 'trash.fill', 'arrow.uturn.left', 'square.and.arrow.up', 'tray.and.arrow.up', 'tray.and.arrow.down', 'pencil', 'plus.square.on.square', 'folder.badge.plus', 'square.and.pencil', 'info.circle', 'doc.on.doc', 'scissors', 'doc.on.clipboard', 'link', 'eye', 'eye.slash', 'star', 'star.fill', 'house.fill', 'arrow.down.circle', 'photo.on.rectangle', 'music.note.list', 'tv', 'clock', 'ellipsis.circle', 'checkmark.circle', 'checkmark.circle.fill', 'circle', 'square.grid.2x2', 'lock', 'cube.box', 'arrow.down.right.and.arrow.up.left', 'arrow.up', 'xmark',
];

if (!fs.existsSync(path.join(source, 'src', 'index.js'))) {
  console.error(`No sfgl checkout at ${source}. Pass its path as the first argument.`);
  process.exit(1);
}
let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // not a git checkout
}

fs.rmSync(target, { recursive: true, force: true });
const copy = (rel) => {
  const from = path.join(source, rel);
  const to = path.join(target, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};
copy('src');
copy('fonts/host-grotesk');
copy('LICENSE');
copy('NOTICE.md');
copy('licenses');
copy('symbols/PROVENANCE.md');
const missing = [];
for (const name of GLYPHS) {
  const file = path.join('symbols', 'glyphs', `${name}.png`);
  if (fs.existsSync(path.join(source, file))) copy(file);
  else missing.push(name);
}
if (missing.length) {
  console.error(`Missing glyphs in sfgl: ${missing.join(', ')}`);
  process.exit(1);
}
fs.writeFileSync(
  path.join(target, 'VENDOR.md'),
  `# Vendored sfgl\n\nCopied by \`scripts/vendor-sfgl.mjs\` from sfgl commit \`${commit}\`.\nDo not edit these files here; change sfgl and run the script again.\n\n- \`src/\`, \`fonts/host-grotesk/\`, \`LICENSE\`, \`NOTICE.md\`, \`licenses/\`: as in sfgl (MIT; the font is SIL OFL 1.1).\n- \`symbols/glyphs/\`: only the ${GLYPHS.length} SF Symbols the web client uses. **These are Apple's artwork, not covered by any license in this repository.** Read \`symbols/PROVENANCE.md\` before distributing them.\n`,
);
console.log(`Vendored sfgl ${commit.slice(0, 7)} into ${path.relative(root, target)} (${GLYPHS.length} glyphs).`);
