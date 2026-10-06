import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';

function installStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return values;
}

function historyMessage({ id, guildId = 'guild-a', channelId = 'channel-a', title = 'Success', description = 'Done.', createdAt = new Date() }) {
  return {
    id,
    guildId,
    channelId,
    author: { id: 'cloudy-bot' },
    client: { user: { id: 'cloudy-bot' } },
    channel: { id: channelId, name: channelId },
    createdAt,
    embeds: [{ title, description, color: 0xFFFFFF }],
    flags: { has: () => false },
  };
}

test('exact bot-history mirrors collapse without touching unique previews', async () => {
  installStorage();

  await registerCloudyEmbedMessage(historyMessage({ id: 'msg-1', createdAt: new Date('2026-10-06T08:00:00.000Z') }), 'bot-history');
  await registerCloudyEmbedMessage(historyMessage({ id: 'msg-2', createdAt: new Date('2026-10-06T08:00:01.000Z') }), 'bot-history');
  await registerCloudyEmbedMessage(historyMessage({
    id: 'msg-3',
    description: 'Different dynamic value.',
  }), 'bot-history');

  const records = await getEmbedRegistry('guild-a');
  const history = records.filter(record => record.source === 'bot-history');

  assert.equal(history.length, 2);
  assert.ok(history.some(record => record.messageId === 'msg-2'));
  assert.ok(history.some(record => record.messageId === 'msg-3'));
  assert.ok(!history.some(record => record.messageId === 'msg-1'));
});

test('identical bot-history snapshots in different channels stay separate', async () => {
  installStorage();

  await registerCloudyEmbedMessage(historyMessage({ id: 'msg-a', channelId: 'channel-a' }), 'bot-history');
  await registerCloudyEmbedMessage(historyMessage({ id: 'msg-b', channelId: 'channel-b' }), 'bot-history');

  const records = await getEmbedRegistry('guild-a');
  assert.equal(records.filter(record => record.source === 'bot-history').length, 2);
});

test('manual Builder embeds are never collapsed by history cleanup', async () => {
  installStorage();

  const first = historyMessage({ id: 'manual-a' });
  const second = historyMessage({ id: 'manual-b' });
  await registerCloudyEmbedMessage(first, 'embed-builder');
  await registerCloudyEmbedMessage(second, 'embed-builder');

  const records = await getEmbedRegistry('guild-a');
  assert.equal(records.filter(record => record.source === 'embed-builder').length, 2);
});

test('expensive gaming catalog inspection is opt-in but orphan cleanup remains automatic', () => {
  const source = fs.readFileSync('src/events/gamingCatalogDiagnosticReady.js', 'utf8');

  assert.match(source, /CLOUDY_CATALOG_DIAGNOSTICS/);
  assert.match(source, /cleanupOrphanCatalogRegistry\(guild\)/);
  assert.match(source, /if \(!ENABLE_CATALOG_DIAGNOSTICS\) return/);
});

test('pre-bootstrap command sync has no artificial default startup delay', () => {
  const source = fs.readFileSync('scripts/register-cloudy-guild-commands.js', 'utf8');

  assert.match(source, /COMMAND_SYNC_START_DELAY_MS \|\| '0'/);
});
