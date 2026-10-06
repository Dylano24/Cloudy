import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { syncExistingEmbedReappearRule } from '../src/services/embedReappearService.js';

const values = new Map();

function resetDb() {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => {
      values.delete(key);
      return true;
    },
  };
}

test('disabling Reappear by current visible copy resolves the original rule and returns its active copy', async () => {
  resetDb();
  values.set('cloudy:embed-reappear-index:guild:general', ['origin-message']);
  values.set('cloudy:embed-reappear:guild:general:origin-message', {
    guildId: 'guild',
    channelId: 'general',
    originMessageId: 'origin-message',
    messageId: 'current-copy',
    embedIndex: 0,
    every: 3,
    count: 2,
    embed: { title: 'Dory' },
    components: [],
  });

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'general',
    messageId: 'current-copy',
    embedIndex: 0,
    every: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.originMessageId, 'origin-message');
  assert.equal(result.activeMessageId, 'current-copy');
  assert.equal(values.has('cloudy:embed-reappear:guild:general:origin-message'), false);
  assert.deepEqual(values.get('cloudy:embed-reappear-index:guild:general'), []);
  assert.ok(values.get('cloudy:embed-reappear-disabled:guild:general:origin-message:0'));
});

test('Builder Save deletion uses canonical Reappear cleanup instead of visible-message rule keys', () => {
  const source = fs.readFileSync('scripts/patch-embed-builder-safe-delete.js', 'utf8');

  assert.match(source, /syncExistingEmbedReappearRule\(\{/);
  assert.match(source, /every:\s*null/);
  assert.equal(source.includes('const reappearKey = `cloudy:embed-reappear:'), false);
});
