import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('start and tests consume committed source without rewriting it', () => {
  assert.equal(pkg.startupPatches, undefined);
  assert.doesNotMatch(pkg.scripts.start, /patch/);
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(fs.existsSync('scripts/apply-startup-patches.js'), false);
  assert.deepEqual(fs.readdirSync('scripts').filter(name => /^patch-.*\.js$/.test(name)), []);
});

test('restore command invokes restoration rather than a disposable drill', () => {
  assert.equal(pkg.scripts['restore:db'], 'node scripts/restore.js');
  assert.equal(pkg.scripts['backup:drill'], 'node scripts/restore-drill.js');
});
