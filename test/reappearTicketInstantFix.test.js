import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { syncExistingEmbedReappearRule } from '../src/services/embedReappearService.js';
import { buildCloudyTicketEmbed } from '../src/utils/ticket/ticketBranding.js';
import { installDefaultEmbedColorPolicy } from '../src/utils/embedColorPolicy.js';

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

test('turning Reappear off leaves an exact tombstone so an in-flight message cannot resurrect it', async () => {
  resetDb();
  values.set('cloudy:embed-reappear-index:guild:general', ['origin']);
  values.set('cloudy:embed-reappear:guild:general:origin', {
    guildId: 'guild',
    channelId: 'general',
    messageId: 'current-copy',
    originMessageId: 'origin',
    embedIndex: 0,
    every: 2,
    count: 1,
    embed: { title: 'Persistent panel' },
    components: [],
  });

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'general',
    messageId: 'current-copy',
    embedIndex: 0,
    every: null,
    embed: { title: 'Persistent panel' },
    components: [],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(values.get('cloudy:embed-reappear-index:guild:general'), []);
  assert.equal(values.has('cloudy:embed-reappear:guild:general:origin'), false);
  assert.ok(values.get('cloudy:embed-reappear-disabled:guild:general:origin:0'));
});

test('turning Reappear back on clears the tombstone', async () => {
  resetDb();
  values.set('cloudy:embed-reappear-disabled:guild:general:origin:0', {
    disabledAt: '2026-10-06T12:00:00.000Z',
  });
  values.set('cloudy:embed-reappear-index:guild:general', ['origin']);
  values.set('cloudy:embed-reappear:guild:general:origin', {
    guildId: 'guild',
    channelId: 'general',
    messageId: 'current-copy',
    originMessageId: 'origin',
    embedIndex: 0,
    every: 2,
    count: 0,
    embed: { title: 'Persistent panel' },
    components: [],
  });

  const result = await syncExistingEmbedReappearRule({
    guildId: 'guild',
    channelId: 'general',
    messageId: 'current-copy',
    embedIndex: 0,
    every: 3,
    embed: { title: 'Persistent panel' },
    components: [],
  });

  assert.equal(result.ok, true);
  assert.equal(values.has('cloudy:embed-reappear-disabled:guild:general:origin:0'), false);
  assert.equal(values.get('cloudy:embed-reappear:guild:general:origin').every, 3);
});

test('Ticket closed is orange on its very first render', () => {
  installDefaultEmbedColorPolicy();
  const embed = buildCloudyTicketEmbed({
    title: 'Ticket closed',
    description: 'This ticket has been closed.',
    color: '#FFFFFF',
  });
  assert.equal(embed.color, 0xFF7A00);
});

test('ticket close modal avoids a visible ephemeral loading state when opened from a message', () => {
  const source = fs.readFileSync('src/handlers/ticketButtons.js', 'utf8');
  const start = source.indexOf('const closeTicketModalHandler');
  const end = source.indexOf('const claimTicketHandler', start);
  const block = source.slice(start, end);

  assert.match(block, /interaction\.isFromMessage\?\.\(\)/);
  assert.match(block, /interaction\.deferUpdate\(\)/);
  assert.match(block, /InteractionHelper\.safeDefer/);
});
