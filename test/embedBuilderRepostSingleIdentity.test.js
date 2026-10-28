import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry, purgeEmbedRegistryRecord, registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';
import { postReplacingManualBuilderMessage } from '../src/services/embedBuilderRepostIdentityService.js';

function setup(t, id, { deleteFails = false } = {}) {
  const guildId = 'single-repost-' + id;
  const sourceChannelId = '177777777777777771';
  const destinationChannelId = '177777777777777772';
  const sourceId = '177777777777777773';
  const newId = '177777777777777774';
  const initial = { guildId, channelId: sourceChannelId, messageId: sourceId,
    embedIndex: 0, source: 'embed-builder', manualSaved: true,
    title: 'Test', name: 'Test', snapshot: { title: 'Test', description: 'Old body' },
    components: [] };
  const data = new Map([['cloudy:embed-registry:' + guildId, [initial]]]);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    data.set(key, structuredClone(value));
    return true;
  });
  let oldLive = true, newLive = false, postCount = 0, saveCount = 0, disableCount = 0;
  const oldMessage = { id: sourceId, guildId, channelId: sourceChannelId,
    author: { id: 'cloudy' }, flags: { has: () => false },
    async delete() {
      if (deleteFails) throw new Error('Missing permission');
      oldLive = false;
    },
  };
  const oldChannel = { id: sourceChannelId, messages: { async fetch(id, options) {
    assert.equal(id, sourceId);
    assert.equal(options.force, true);
    assert.equal(oldLive, true);
    return oldMessage;
  }} };
  const channel = { id: destinationChannelId };
  const guild = { id: guildId, client: { user: { id: 'cloudy' } },
    channels: { cache: new Map([[sourceChannelId, oldChannel], [destinationChannelId, channel]]) } };
  const target = { ...initial };
  const postNew = async () => {
    postCount++;
    newLive = true;
    const sent = { id: newId, guildId, channelId: destinationChannelId,
      channel: { ...channel, name: 'general' }, author: { id: 'cloudy' },
      client: guild.client, embeds: [{ title: 'Yess', description: 'Updated body' }],
      components: [],
    };
    assert.equal(await registerCloudyEmbedMessage(sent, 'embed-builder', { manualSave: true }), true);
    return { ok: true, destination: channel, rollback: async () => {
      newLive = false;
      await purgeEmbedRegistryRecord(guildId, destinationChannelId, newId, null);
    }};
  };
  const saveExisting = async () => { saveCount++; return { ok: true }; };
  const disableReappear = async () => { disableCount++; return { ok: true }; };
  return {
    guild, channel, oldChannel, target, postNew, saveExisting, disableReappear,
    sourceId, newId,
    status: () => ({ oldLive, newLive, postCount, saveCount, disableCount }),
  };
}

test('Repost to the existing channel updates the same message, never makes a duplicate', async t => {
  const f = setup(t, 'same-channel');
  const result = await postReplacingManualBuilderMessage({
    ...f, channel: f.oldChannel,
  });
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.deepEqual(f.status(), { oldLive: true, newLive: false,
    postCount: 0, saveCount: 1, disableCount: 0 });
  assert.deepEqual((await getEmbedRegistry(f.guild.id)).map(x => x.messageId), [f.sourceId]);
});

test('moving an existing Builder embed replaces old physical and old registry identity', async t => {
  const f = setup(t, 'move-across-channels');
  const result = await postReplacingManualBuilderMessage(f);
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.deepEqual(f.status(), { oldLive: false, newLive: true,
    postCount: 1, saveCount: 0, disableCount: 1 });
  const records = await getEmbedRegistry(f.guild.id);
  assert.deepEqual(records.map(x => x.messageId), [f.newId]);
  assert.equal(records[0].snapshot.title, 'Yess');
  assert.ok(records.every(x => x.title !== 'Test'), 'old title is absent from persistent log');
});

test('a failed old-message deletion rolls back the replacement and keeps the original', async t => {
  const f = setup(t, 'rollback-on-failure', { deleteFails: true });
  const result = await postReplacingManualBuilderMessage(f);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'original-delete-failed');
  assert.deepEqual(f.status(), { oldLive: true, newLive: false,
    postCount: 1, saveCount: 0, disableCount: 0 });
  assert.deepEqual((await getEmbedRegistry(f.guild.id)).map(x => x.messageId), [f.sourceId]);
});

test('normal new Post has no prior identity and is never replaced or deleted', async t => {
  const f = setup(t, 'new-independent-post');
  const result = await postReplacingManualBuilderMessage({ ...f, target: null });
  assert.equal(result.ok, true);
  assert.equal(f.status().oldLive, true);
  assert.equal(f.status().newLive, true);
  assert.equal(f.status().postCount, 1);
  assert.equal((await getEmbedRegistry(f.guild.id)).length, 2);
});
