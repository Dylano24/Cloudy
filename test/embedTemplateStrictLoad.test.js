import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes } from '../src/services/embedTemplateService.js';

test('failed first template load prevents writes and is retried after recovery', async t => {
  let fail = true;
  let writes = 0;
  let saved;
  t.mock.method(db, 'get', async () => {
    if (fail) throw new Error('database offline');
    return { protected: { title: 'Owner saved template' } };
  });
  t.mock.method(db, 'set', async (_key, value) => { writes++; saved = value; return true; });
  const guild = 'strict-template-recovery';
  assert.equal(await saveEmbedTemplateDecoration(guild, 'channel', ['new'], { title: 'New' }), false);
  assert.equal(writes, 0);
  fail = false;
  assert.equal(await saveEmbedTemplateDecoration(guild, 'channel', ['new'], { title: 'New' }), true);
  assert.equal(saved.protected.title, 'Owner saved template');
  assert.equal(writes, 1);
});

test('template warm-up tolerates failed scopes and retries only unsuccessful reads', async t => {
  const reads = new Map();
  let fail = true;
  t.mock.method(db, 'get', async key => {
    reads.set(key, (reads.get(key) || 0) + 1);
    if (key.endsWith(':bad') && fail) throw new Error('scope offline');
    return {};
  });
  const guild = 'strict-template-warm';
  await warmSavedEmbedTemplateScopes(guild, ['good', 'bad']);
  fail = false;
  await warmSavedEmbedTemplateScopes(guild, ['good', 'bad']);
  assert.equal(reads.get(`cloudy:embed-template:${guild}:good`), 1);
  assert.equal(reads.get(`cloudy:embed-template:${guild}:bad`), 2);
});
