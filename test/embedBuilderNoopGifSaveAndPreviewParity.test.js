import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import {
  saveModifiedEmbed, loadRecordSnapshotIntoState,
} from '../src/services/embedManagerService.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guildId = 'builder-noop-gif-sync-20261027';
const channelId = '187777777777777771';
const messageId = '187777777777777772';
const attachmentId = '187777777777777773';
const attachmentName = 'cloudy-banner.gif';
const imageUrl = 'https://cdn.discordapp.com/attachments/'
  + channelId + '/' + attachmentId + '/' + attachmentName + '?ex=signed';

function fixture(t, override = {}) {
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    storage.set(key, structuredClone(value));
    return true;
  });
  const data = {
    title: 'TEST', description: 'Latest content',
    color: 0xFF1493, image: { url: imageUrl },
    thumbnail: { url: 'https://example.com/cloudy-logo.png' },
    footer: { text: 'Cloudy footer' },
  };
  const message = {
    id: messageId, guildId, channelId,
    author: { id: 'bot' }, content: '', components: [],
    flags: { has: () => false },
    embeds: [new Embed(data)],
    attachments: new Collection([[attachmentId, {
      id: attachmentId, name: attachmentName, url: imageUrl,
      proxyURL: imageUrl,
    }]]),
    editCalls: [],
  };
  const channel = {
    id: channelId, name: 'general',
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => message },
  };
  message.channel = channel;
  message.edit = async payload => {
    message.editCalls.push(payload);
    message.embeds = payload.embeds.map(embed => new Embed({
      ...embed, image: embed.image?.url?.startsWith('attachment://')
        ? { url: imageUrl } : embed.image,
    }));
    return message;
  };
  const guild = {
    id: guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channelId, channel]]) },
  };
  const state = {
    title: data.title, message: data.description, sideColor: data.color,
    bottomLine: data.footer.text, embedFields: [],
    showLogo: true, mediaUrl: imageUrl,
    modifyTarget: {
      guildId, channelId, messageId, embedIndex: 0, source: 'embed-builder',
      sourceEmbedData: data, previewSourceData: data,
      cachedMessage: message, templateMode: false,
    }, ...override,
  };
  return { data, state, message, guild, storage };
}

test('1000 Save clicks without edits never PATCH a GIF; Search remains on the same saved message', async t => {
  const { state, message, guild } = fixture(t);
  for (let index = 0; index < 1000; index++) {
    const result = await saveModifiedEmbed(guild, state);
    assert.equal(result.ok, true, 'Save #' + index);
    assert.equal(message.editCalls.length, 0, 'no physical Discord PATCH for Save #' + index);
    assert.equal(result.message.id, messageId);
    assert.equal(result.updatedCount, 0);
    assert.equal(state.sideColor, 0xFF1493);
  }
  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.title, 'TEST');
  assert.equal(records[0].snapshot.image.url, imageUrl);
  assert.equal(records[0].snapshot.color, 0xFF1493);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, records, 'TEST')).map(x => x.name), ['TEST']);
});

test('real title/text/color changes still edit the existing physical message', async t => {
  const { state, message, guild } = fixture(t);
  state.title = 'TEST 2';
  state.message = 'Updated body';
  state.sideColor = 0x4285F4;
  const result = await saveModifiedEmbed(guild, state);
  assert.equal(result.ok, true);
  assert.equal(message.editCalls.length, 1);
  assert.equal(message.editCalls[0].embeds[0].title, 'TEST 2');
  assert.equal(message.editCalls[0].embeds[0].color, 0x4285F4);
  assert.equal(message.editCalls[0].embeds[0].description, 'Updated body');
  assert.equal(result.message.id, messageId);
  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.title, 'TEST 2');
});

test('Search and channel Builder use latest authoritative manually saved physical embed', () => {
  const guild = { id: guildId };
  const latest = {
    guildId, channelId, messageId, source: 'embed-builder',
    manualSaved: true, updatedAt: '2026-10-27T07:10:00Z',
    snapshot: {
      title: 'TEST 2', description: 'Latest body from channel Builder',
      color: 0xFF1493, image: { url: imageUrl },
      fields: [{ name: 'Current field', value: 'Current value', inline: true }],
    },
  };
  const stalePeer = {
    ...latest, source: 'bot-history', manualSaved: false,
    messageId: '187777777777777774',
    snapshot: {
      title: 'TEST', description: 'Old preview body',
      color: 0x4285F4, image: { url: 'https://example.com/old.gif' },
    },
  };
  // Normal channel selection and Search selection can pass different stale
  // peers, but both MUST load the same saved physical snapshot.
  for (const peer of [null, stalePeer]) {
    const state = {};
    assert.equal(loadRecordSnapshotIntoState(state, guild, latest, peer, stalePeer), true);
    assert.equal(state.title, 'TEST 2');
    assert.equal(state.message, 'Latest body from channel Builder');
    assert.equal(state.sideColor, 0xFF1493);
    assert.equal(state.mediaUrl, imageUrl);
    assert.deepEqual(state.embedFields, latest.snapshot.fields);
    assert.equal(state.modifyTarget.sourceEmbedData.title, 'TEST 2');
  }
});


test('real repeated Save updates one physical embed with full current preview and attached GIF', async t => {
  const { state, message, guild } = fixture(t);
  for (let index = 0; index < 12; index++) {
    const title = 'Latest edition ' + index;
    const description = ('Long description ' + index + ' ').repeat(30);
    const color = 0x100000 + index * 12345;
    state.title = title;
    state.message = description;
    state.sideColor = color;
    const result = await saveModifiedEmbed(guild, state);
    assert.equal(result.ok, true, 'Save #' + index);
    assert.equal(result.message.id, messageId);
    assert.equal(message.embeds[0].title, title);
    assert.equal(message.embeds[0].description, description);
    assert.equal(message.embeds[0].color, color);
    assert.equal(state.modifyTarget.previewSourceData.title, title);
    assert.equal(state.modifyTarget.previewSourceData.description, description);
    assert.equal(state.modifyTarget.previewSourceData.color, color);
    assert.equal(state.modifyTarget.previewSourceData.image.url, imageUrl);
    assert.equal(message.editCalls[index].embeds[0].image.url, 'attachment://' + attachmentName);
    assert.deepEqual(message.editCalls[index].attachments, [{ id: attachmentId }]);
  }
  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, messageId);
  assert.equal(records[0].snapshot.title, 'Latest edition 11');
  assert.equal(records[0].snapshot.color, 0x100000 + 11 * 12345);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, records, 'Latest edition 11'))
    .map(x => x.name), ['Latest edition 11']);
});
