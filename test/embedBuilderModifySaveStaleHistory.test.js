import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, registerCloudyEmbedMessage, peekEmbedRegistry } from '../src/services/embedRegistryService.js';
import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('Modify Save is authoritative: stale bot-history cannot restore old title or body', async t => {
  const guildId = 'modify-save-old-history-20261027';
  const channelId = '181234567890123456';
  const messageId = '181234567890123457';
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });

  function message(title, description) {
    return {
      id: messageId, guildId, channelId, content: '',
      author: { id: 'bot' }, client: { user: { id: 'bot' } },
      embeds: [{ title, description, color: 0xFFFFFF }],
      components: [],
    };
  }

  const original = message('Test 1', 'Original middle text');
  const updated = message('Test 2', 'Updated middle text');

  // An existing automatic embed is edited through Modify. This must retain
  // its existing physical identity and be treated as manually saved.
  assert.equal(await registerCloudyEmbedMessage(updated, 'modified', { manualSave: true }), true);

  // A slow history sweep completes using an older copy of the same Discord
  // message. It is not a second Post or another legitimate embed.
  assert.equal(await registerCloudyEmbedMessage(original, 'bot-history'), true);

  const saved = await getEmbedRegistry(guildId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].messageId, messageId);
  assert.equal(saved[0].manualSaved, true);
  assert.equal(saved[0].source, 'modified');
  assert.deepEqual(
    [saved[0].snapshot.title, saved[0].snapshot.description],
    ['Test 2', 'Updated middle text'],
  );
  assert.deepEqual(peekEmbedRegistry(guildId).map(x => x.snapshot.title), ['Test 2']);

  const guild = { id: guildId, channels: { cache: new Map([[channelId, {
    id: channelId, name: 'botlog', permissionsFor: () => ({ has: () => true }),
  }]]) } };
  assert.deepEqual(
    buildSearchChoices(buildMatches(guild, saved, 'test')).map(choice => choice.name),
    ['Test 2'],
  );
});

test('stale bot-history cannot restore old content of manually saved existing catalog master', async t => {
  const guildId = 'catalog-modify-history-20261027';
  const channelId = '181234567890123458';
  const messageId = '181234567890123459';
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  const source = {
    guildId, channelId, id: messageId, author: { id: 'bot' },
    client: { user: { id: 'bot' } }, content: '',
    embeds: [{ title: 'Test 2', description: 'Current text', color: 0xFFFFFF }],
    components: [],
  };
  assert.equal(await registerCloudyEmbedMessage(source, 'modified-template', { manualSave: true }), true);
  const earlier = { ...source, embeds: [{ title: 'Test 1', description: 'Older text', color: 0xFFFFFF }] };
  assert.equal(await registerCloudyEmbedMessage(earlier, 'bot-history'), true);
  const records = await getEmbedRegistry(guildId);
  assert.deepEqual(records.map(record => [record.source, record.snapshot.title, record.snapshot.description]), [
    ['modified-template', 'Test 2', 'Current text'],
  ]);
});
