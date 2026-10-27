import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { buildUserErrorEmbed } from '../src/utils/embeds.js';
import { db } from '../src/utils/database.js';
import {
  saveModifiedEmbed, loadRecordSnapshotIntoState, getCanonicalBuilderRecords, collapseDisplayRecords,
} from '../src/services/embedManagerService.js';
import {
  getEmbedRegistry, purgeEmbedRegistryRecord, registerCloudyEmbedMessage, isRecentlyPurgedMessage,
} from '../src/services/embedRegistryService.js';
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

test('editing text keeps the live inline GIF when Search holds an old CDN signature', async t => {
  const { state, message, guild } = fixture(t);
  state.message = 'A longer updated message that should not detach the banner.';
  state.sideColor = 0x556677;
  state.mediaUrl = 'https://cdn.discordapp.com/attachments/'
    + channelId + '/' + attachmentId + '/' + attachmentName + '?ex=old-signature';
  state.mediaTouched = false;
  state.modifyTarget.previewSourceData = {
    ...state.modifyTarget.previewSourceData, image: { url: state.mediaUrl },
  };
  state.modifyTarget.sourceEmbedData = {
    ...state.modifyTarget.sourceEmbedData, image: { url: state.mediaUrl },
  };
  const result = await saveModifiedEmbed(guild, state);
  assert.equal(result.ok, true);
  assert.equal(message.editCalls.length, 1);
  assert.equal(message.editCalls[0].embeds[0].description, state.message);
  assert.equal(message.editCalls[0].embeds[0].image.url, 'attachment://' + attachmentName);
  assert.deepEqual(message.editCalls[0].attachments, [{ id: attachmentId }]);
  assert.equal(state.mediaUrl, imageUrl);
  assert.equal(state.mediaTouched, false);
  // Repeated unchanged Save must not PATCH or restore the old signed URL.
  for (let i = 0; i < 5; i++) assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.editCalls.length, 1);
  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.description, state.message);
  assert.equal(records[0].snapshot.image.url, imageUrl);
});

test('explicit Remove media clears the banner rather than restoring the old GIF', async t => {
  const { state, message, guild } = fixture(t);
  state.mediaUrl = null;
  state.mediaTouched = true;
  const result = await saveModifiedEmbed(guild, state);
  assert.equal(result.ok, true);
  assert.equal(message.editCalls.length, 1);
  assert.equal(message.editCalls[0].embeds[0].image, undefined);
  assert.equal(state.mediaUrl, null);
  assert.equal(state.mediaTouched, false);
});

test('Builder unknown error has the original generic title and does not substitute ticket text', () => {
  const error = buildUserErrorEmbed('unknown', 'The message builder could not complete that action.', {
    preserveText: true,
  });
  assert.equal(error.toJSON().title, 'Something went wrong');
  assert.equal(error.toJSON().description, 'The message builder could not complete that action.');
});

test('Search opens saved manual GIF as one physical embed, never a shared template', async t => {
  const { state, message, guild } = fixture(t);
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const registered = await getEmbedRegistry(guildId);
  const canonical = await getCanonicalBuilderRecords(guild, registered);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].messageId, messageId);
  assert.equal(canonical[0].templateMode, false);
  const fromSearch = {};
  assert.equal(loadRecordSnapshotIntoState(fromSearch, guild, canonical[0],
    canonical[0].previewRecord, canonical[0].sourceRecord), true);
  assert.equal(fromSearch.modifyTarget.templateMode, false);
  assert.equal(fromSearch.mediaUrl, imageUrl);
  for (let i = 0; i < 10; i++) assert.equal((await saveModifiedEmbed(guild, fromSearch)).ok, true);
  assert.equal(message.editCalls.length, 0);
});

test('distinct owner posts with an identical title remain distinct physical choices', () => {
  const snapshot = { title: 'My banner', description: 'Saved', color: 0xAA0011 };
  const records = ['187777777777777772', '187777777777777779'].map(messageId => ({
    guildId, channelId, messageId, source: 'embed-builder', manualSaved: true,
    snapshot, name: 'My banner', title: 'My banner',
  }));
  const collapsed = collapseDisplayRecords(records, channelId);
  assert.equal(collapsed.length, 2);
  assert.ok(collapsed.every(record => !record.templateMode));
});

test('two sessions never overwrite a newer physical Save with stale editor state', async t => {
  const { state, message, guild } = fixture(t);
  const another = {
    ...state,
    modifyTarget: {
      ...state.modifyTarget,
      sourceEmbedData: structuredClone(state.modifyTarget.sourceEmbedData),
      previewSourceData: structuredClone(state.modifyTarget.previewSourceData),
    },
  };
  state.title = 'Latest title';
  state.message = 'Latest saved body';
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  another.title = 'Stale draft title';
  const stale = await saveModifiedEmbed(guild, another);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-editor');
  assert.equal(message.embeds[0].title, 'Latest title');
  assert.equal(message.editCalls.length, 1);
});

test('simultaneous Saves of the same message cannot send a stale second PATCH', async t => {
  const { state, message, guild } = fixture(t);
  const stale = {
    ...state, title: 'Stale parallel change',
    modifyTarget: { ...state.modifyTarget,
      sourceEmbedData: structuredClone(state.modifyTarget.sourceEmbedData),
      previewSourceData: structuredClone(state.modifyTarget.previewSourceData) },
  };
  state.title = 'First committed change';
  const results = await Promise.all([saveModifiedEmbed(guild, state), saveModifiedEmbed(guild, stale)]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].reason, 'stale-editor');
  assert.equal(message.editCalls.length, 1);
  assert.equal(message.embeds[0].title, 'First committed change');
});

test('Delete persists immutable message tombstone and rejects a delayed gateway registration', async t => {
  const { state, message, guild, storage } = fixture(t);
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal((await getEmbedRegistry(guildId)).length, 1);
  assert.equal(await purgeEmbedRegistryRecord(guildId, channelId, messageId, null), true);
  const deletes = storage.get('cloudy:embed-registry-deleted:' + guildId);
  assert.equal(deletes[channelId + ':' + messageId], true);
  assert.equal(isRecentlyPurgedMessage({ guildId, channelId, messageId }), true);
  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true }), true);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('cold guild hydrates persisted Delete before exposing or accepting old records', async t => {
  const { storage, message } = fixture(t);
  const coldGuildId = 'builder-cold-restart-tombstones-20261027';
  const oldRecord = {
    guildId: coldGuildId, channelId, messageId, embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    title: 'Old ghost', name: 'Old ghost',
    snapshot: { title: 'Old ghost', color: 0xFFFFFF },
  };
  storage.set('cloudy:embed-registry:' + coldGuildId, [oldRecord]);
  storage.set('cloudy:embed-registry-deleted:' + coldGuildId, {
    [channelId + ':' + messageId]: true,
  });
  assert.deepEqual(await getEmbedRegistry(coldGuildId), []);
  assert.equal(isRecentlyPurgedMessage(oldRecord), true);
  const late = { ...message, guildId: coldGuildId };
  assert.equal(await registerCloudyEmbedMessage(late, 'embed-builder', { manualSave: true }), true);
  assert.deepEqual(await getEmbedRegistry(coldGuildId), []);
});
