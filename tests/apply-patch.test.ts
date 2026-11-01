import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, applyPatchScript } from '@sfagents/core';
import { makeTempDir } from './helpers.js';

describe('apply_patch', () => {
  test('adds, updates (keeping CRLF), moves and deletes files', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\r\nif (x || y) {\r\n  run("two words");\r\n}\r\n');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'bye\n');
    fs.writeFileSync(path.join(dir, 'm.txt'), 'one\ntwo\n');
    const summary = applyPatch(`*** Begin Patch
*** Add File: sub/new.md
+# Title
+line with "quotes" && pipes |
*** Update File: a.ts
@@ if (x || y) {
-  run("two words");
+  run("three words here");
+  done();
*** Delete File: old.txt
*** Update File: m.txt
*** Move to: moved/m.txt
@@
 one
-two
+2
*** End Patch`, dir);
    assert.match(summary, /A sub\/new\.md/);
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'new.md'), 'utf8'), '# Title\nline with "quotes" && pipes |\n');
    assert.equal(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), 'const a = 1;\r\nif (x || y) {\r\n  run("three words here");\r\n  done();\r\n}\r\n');
    assert.equal(fs.existsSync(path.join(dir, 'old.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'm.txt')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'moved', 'm.txt'), 'utf8'), 'one\n2\n');
  });

  test('a patch that does not apply changes nothing', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    assert.throws(() => applyPatch('*** Begin Patch\n*** Add File: b.txt\n+b\n*** Update File: a.txt\n-missing\n+x\n*** End Patch', dir), /Could not find/);
    assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
    assert.throws(() => applyPatch('*** Update File: a.txt\n', dir), /Begin Patch/);
  });

  test('the sandbox script parses', () => {
    assert.doesNotThrow(() => new Function(applyPatchScript().replace(/^#!.*\n/, '')));
  });
});
