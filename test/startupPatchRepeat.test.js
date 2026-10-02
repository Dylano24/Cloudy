import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('startup patches run once, verify the result on restart and reject changed source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudy-patches-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.copyFileSync('scripts/apply-startup-patches.js', path.join(root, 'scripts/apply-startup-patches.js'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', startupPatches: ['scripts/once.js'] }));
    fs.writeFileSync(path.join(root, 'src/value.js'), 'original');
    fs.writeFileSync(path.join(root, 'scripts/once.js'), `import fs from 'node:fs';
      if (fs.readFileSync('src/value.js', 'utf8') !== 'original') process.exit(42);
      fs.writeFileSync('src/value.js', 'patched');`);
    const run = () => spawnSync(process.execPath, ['scripts/apply-startup-patches.js'], { cwd: root, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0, 'non-repeatable patch must not run twice');
    assert.equal(fs.readFileSync(path.join(root, 'src/value.js'), 'utf8'), 'patched');
    fs.writeFileSync(path.join(root, 'src/value.js'), 'changed');
    assert.notEqual(run().status, 0, 'changed runtime cannot reuse a stale successful stamp');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
