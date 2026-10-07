import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test('latency guards run after every legacy UI rewrite and can run twice without changing output', () => {
  const { startupPatches } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(startupPatches.at(-1), 'scripts/patch-interaction-latency.js');
  const files = ['src/services/embedRegistryService.js', 'src/services/embedManagerService.js',
    'src/commands/Tools/embedbuilder.js', 'src/commands/Tools/zz_embedbuilderLiveSearchPatch.js',
    'src/utils/interactionHelper.js', 'src/services/reportCaseLifecycleService.js'];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  // npm test has already run the entire ordered startup list.
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync(process.execPath, ['scripts/patch-interaction-latency.js'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  }
});
