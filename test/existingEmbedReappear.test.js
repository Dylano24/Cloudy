import assert from 'node:assert/strict';
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

test('existing embed can enable Reappear=2 and persists a live rule', async () => {
  resetDb();

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'nsfw',
    messageId: 'existing-message',
    embedIndex: 0,
    every: 2,
    embed: { title: '🔞 Get freaky!', description: 'Adult channel rules' },
    components: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.originMessageId, 'existing-message');

  const index = values.get('cloudy:embed-reappear-index:guild:nsfw');
  assert.deepEqual(index, ['existing-message']);

  const rule = values.get('cloudy:embed-reappear:guild:nsfw:existing-message');
  assert.equal(rule.every, 2);
  assert.equal(rule.count, 0);
  assert.equal(rule.messageId, 'existing-message');
  assert.equal(rule.originMessageId, 'existing-message');
  assert.equal(rule.embed.title, '🔞 Get freaky!');
});

test('editing the currently reappeared copy updates the same rule instead of creating a duplicate', async () => {
  resetDb();
  values.set('cloudy:embed-reappear-index:guild:nsfw', ['origin-message']);
  values.set('cloudy:embed-reappear:guild:nsfw:origin-message', {
    guildId: 'guild',
    channelId: 'nsfw',
    messageId: 'current-copy',
    originMessageId: 'origin-message',
    embedIndex: 0,
    every: 2,
    count: 1,
    embed: { title: 'Old' },
    components: [],
  });

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'nsfw',
    messageId: 'current-copy',
    embedIndex: 0,
    every: 3,
    embed: { title: 'Updated' },
    components: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.originMessageId, 'origin-message');
  assert.deepEqual(values.get('cloudy:embed-reappear-index:guild:nsfw'), ['origin-message']);
  assert.equal(values.has('cloudy:embed-reappear:guild:nsfw:current-copy'), false);
  assert.equal(values.get('cloudy:embed-reappear:guild:nsfw:origin-message').every, 3);
  assert.equal(values.get('cloudy:embed-reappear:guild:nsfw:origin-message').count, 0);
});

test('blank Reappear disables only the matching existing embed rule', async () => {
  resetDb();
  values.set('cloudy:embed-reappear-index:guild:nsfw', ['origin-a', 'origin-b']);
  values.set('cloudy:embed-reappear:guild:nsfw:origin-a', {
    messageId: 'current-a', originMessageId: 'origin-a', embedIndex: 0, every: 2, embed: { title: 'A' },
  });
  values.set('cloudy:embed-reappear:guild:nsfw:origin-b', {
    messageId: 'current-b', originMessageId: 'origin-b', embedIndex: 0, every: 4, embed: { title: 'B' },
  });

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'nsfw',
    messageId: 'current-a',
    embedIndex: 0,
    every: null,
    embed: { title: 'A' },
    components: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(values.get('cloudy:embed-reappear-index:guild:nsfw'), ['origin-b']);
  assert.equal(values.has('cloudy:embed-reappear:guild:nsfw:origin-a'), false);
  assert.equal(values.has('cloudy:embed-reappear:guild:nsfw:origin-b'), true);
});
