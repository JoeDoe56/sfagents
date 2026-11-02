import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { patchFormatFor, sfaPatch, sfaPatchScript } from '@sfagents/core';
import { makeTempDir } from './helpers.js';

function dirWith(files: Record<string, string>): string {
  const dir = makeTempDir();
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

describe('sfa-patch: search/replace blocks', () => {
  test('changes and creates files, several blocks and files per call, keeping CRLF', () => {
    const dir = dirWith({ 'src/a.py': 'def f():\r\n    return 1\r\n\r\ndef g():\r\n    return 2\r\n' });
    const out = sfaPatch(
      [
        'src/a.py',
        '```python',
        '<<<<<<< SEARCH',
        '    return 1',
        '=======',
        '    return 10',
        '>>>>>>> REPLACE',
        '```',
        'src/a.py',
        '<<<<<<< SEARCH',
        'def g():   ',
        '    return 2',
        '=======',
        'def g():',
        '    return 20',
        '    # done',
        '>>>>>>> REPLACE',
        '',
        'notes/new.md',
        '<<<<<<< SEARCH',
        '=======',
        '# New',
        '>>>>>>> REPLACE',
      ].join('\n'),
      dir,
    );
    assert.equal(read(dir, 'src/a.py'), 'def f():\r\n    return 10\r\n\r\ndef g():\r\n    return 20\r\n    # done\r\n');
    assert.equal(read(dir, 'notes/new.md'), '# New\n');
    assert.match(out, /^M src\/a\.py \(\+3 -2\)$/m);
    assert.match(out, /^A notes\/new\.md \(\+1 -0\)$/m);
  });

  test('no match, several matches and wrong indentation are refused with the nearest lines; nothing changes', () => {
    const dir = dirWith({ 'a.js': 'if (x) {\n  run();\n}\nif (y) {\n  run();\n}\n', 'b.js': 'one\n' });
    const block = (file: string, old: string, neu: string) => `${file}\n<<<<<<< SEARCH\n${old}\n=======\n${neu}\n>>>>>>> REPLACE\n`;
    assert.throws(() => sfaPatch(block('b.js', 'one', 'ONE') + block('a.js', '  run();', 'go();'), dir), /2 matches in a\.js \(lines 2, 5\)/);
    assert.equal(read(dir, 'b.js'), 'one\n', 'all or nothing');
    assert.throws(() => sfaPatch(block('a.js', 'if (x) {\nrun();', 'z'), dir), /No match in a\.js[\s\S]*nearest lines[\s\S]*1 \| if \(x\) \{[\s\S]*Indentation must match/);
    assert.throws(() => sfaPatch(block('missing.js', 'a', 'b'), dir), /missing\.js does not exist/);
    assert.throws(() => sfaPatch('b.js\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n', dir), /already exists/);
    assert.throws(() => sfaPatch('just some text', dir), /Unrecognized edit/);
  });
});

describe('sfa-patch: apply_patch', () => {
  test('adds, updates (with anchors), moves and deletes; all or nothing', () => {
    const dir = dirWith({ 'a.txt': 'alpha\nbeta\ngamma\n', 'old.txt': 'x\n', 'gone.txt': 'bye\n' });
    const out = sfaPatch(
      `*** Begin Patch
*** Update File: a.txt
@@ alpha
-beta
+BETA
*** Add File: dir/new.txt
+hello
+world
*** Update File: old.txt
*** Move to: moved/old.txt
@@
-x
+y
*** Delete File: gone.txt
*** End Patch`,
      dir,
    );
    assert.equal(read(dir, 'a.txt'), 'alpha\nBETA\ngamma\n');
    assert.equal(read(dir, 'dir/new.txt'), 'hello\nworld\n');
    assert.equal(read(dir, 'moved/old.txt'), 'y\n');
    assert.equal(fs.existsSync(path.join(dir, 'old.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
    assert.match(out, /M a\.txt \(\+1 -1\)/);
    assert.match(out, /R old\.txt -> moved\/old\.txt/);
    assert.match(out, /D gone\.txt/);
    assert.throws(() => sfaPatch('*** Begin Patch\n*** Add File: b.txt\n+b\n*** Update File: a.txt\n-missing\n+x\n*** End Patch', dir), /No match in a\.txt/);
    assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false, 'nothing written');
    assert.throws(() => sfaPatch('*** Begin Patch\n*** Update File: a.txt\n-   alpha\n+x\n*** End Patch', dir), /No match/, 'indentation must match');
  });

  test('the container script is valid JavaScript; models get the format they know', () => {
    assert.doesNotThrow(() => new Function(sfaPatchScript().replace(/^#!.*\n/, '')));
    assert.equal(patchFormatFor('openai/gpt-6-luna'), 'apply-patch');
    assert.equal(patchFormatFor('gpt-5-codex'), 'apply-patch');
    assert.equal(patchFormatFor('anything', 'codex'), 'apply-patch');
    assert.equal(patchFormatFor('anthropic/claude-haiku-5.5'), 'search-replace');
    assert.equal(patchFormatFor('qwen/qwen3.8-flash'), 'search-replace');
    assert.equal(patchFormatFor(undefined), 'search-replace');
  });
});
