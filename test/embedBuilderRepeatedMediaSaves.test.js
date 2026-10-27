import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import {
  saveModifiedEmbed,
  loadRecordSnapshotIntoState,
  preserveExistingEmbedBannerAttachment,
} from '../src/services/embedManagerService.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('an uploaded GIF, original color, one ID and Search/Modify parity survive consecutive Saves', async t => {
  const guildId = 'repeat-media-modify-100-20261027';
  const channelId = '186666666666665551';
  const messageId = '186666666666665552';
  const fileId = '186666666666665553';
  const fileName = 'banner.gif';
  const cdnUrl = 'https://cdn.discordapp.com/attachments/'
    + channelId + '/' + fileId + '/' + fileName + '?ex=signed';
  const color = 0xFF1493;
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    storage.set(key, structuredClone(value));
    return true;
  });
  const edits = [];
  const message = {
    id: messageId, guildId, channelId, content: '', author: { id: 'bot' },
    flags: { has: () => false }, components: [],
    embeds: [new Embed({ title: 'YES', description: 'Initial body', color })],
    attachments: new Collection(),
  };
  const channel = { id: channelId, name: 'general',
    messages: { fetch: async id => {
      assert.equal(String(id), messageId);
      return message;
    } }, permissionsFor: () => ({ has: () => true }),
  };
  const guild = { id: guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channelId, channel]]) } };
  message.channel = channel;
  message.edit = async payload => {
    edits.push(payload);
    // An uploaded attachment gets a resolved Discord CDN URL in the returned
    // edited message. Subsequent edits must not reupload another copy.
    if (payload.files?.length) {
      message.attachments.set(fileId, {
        id: fileId, name: fileName, url: cdnUrl, proxyURL: cdnUrl,
      });
    }
    message.embeds = payload.embeds.map(item => new Embed({
      ...item, image: item.image?.url?.startsWith('attachment://')
        ? { url: cdnUrl } : item.image,
    }));
    return message;
  };
  const original = message.embeds[0].toJSON();
  const state = {
    title: 'YES2', message: 'Edited body', embedFields: [],
    sideColor: color, showLogo: false, logoTouched: true,
    mediaBuffer: Buffer.from('GIF89a valid mock bytes'),
    mediaName: fileName, mediaUrl: null, bottomLine: 'Cloudy',
    modifyTarget: {
      guildId, channelId, backingChannelId: channelId,
      messageId, embedIndex: 0, source: 'embed-builder',
      sourceEmbedData: original, previewSourceData: original,
      templateMode: false, hadBuilderMarker: false,
    },
  };

  const first = await saveModifiedEmbed(guild, state);
  assert.equal(first.ok, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].files.length, 1, 'the first user upload is sent once');
  assert.equal(state.mediaBuffer, null, 'the uploaded buffer was consumed');
  assert.equal(state.mediaName, null);
  assert.equal(state.mediaUrl, cdnUrl);

  for (let i = 3; i <= 102; i++) {
    state.title = 'YES' + i;
    state.message = 'Edited body ' + i;
    const updated = await saveModifiedEmbed(guild, state);
    assert.equal(updated.ok, true, 'repeated Save #' + i);
    const payload = edits.at(-1);
    assert.equal(payload.files, undefined, 'no reupload on Save #' + i);
    assert.deepEqual(payload.attachments, [{ id: fileId }]);
    assert.equal(payload.embeds[0].image.url, 'attachment://' + fileName);
    assert.equal(payload.embeds[0].color, color);
    assert.equal(message.embeds[0].image.url, cdnUrl);
    assert.equal(message.embeds[0].title, 'YES' + i);
    assert.equal(message.embeds[0].description, 'Edited body ' + i);
    assert.equal(state.modifyTarget.messageId, messageId, 'same physical message identity');
  }
  assert.equal(edits.length, 101);
  assert.equal(message.attachments.size, 1);
  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1, 'only one registry item');
  assert.equal(records[0].messageId, messageId);
  assert.equal(records[0].snapshot.color, color);
  assert.equal(records[0].snapshot.image.url, cdnUrl);
  assert.equal(records[0].snapshot.title, 'YES102');
  const previewState = {};
  assert.equal(loadRecordSnapshotIntoState(previewState, guild, records[0]), true);
  assert.equal(previewState.sideColor, color);
  assert.equal(previewState.mediaUrl, cdnUrl);
  assert.equal(previewState.title, 'YES102');
  assert.deepEqual(buildSearchChoices(buildMatches(guild, records, 'YES102')).map(v => v.name), ['YES102']);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, records, 'YES2')), []);
});

test('inline GIF attachment logic is idempotent for 1000 title-only edits', () => {
  const channelId = '186666666666665551';
  const id = '186666666666665553';
  const name = 'banner.gif';
  const url = 'https://cdn.discordapp.com/attachments/' + channelId + '/' + id + '/' + name + '?ex=abc';
  const message = {
    embeds: [{ image: { url } }],
    attachments: new Collection([[id, { id, name, url, proxyURL: url }]]),
  };
  for (let i = 0; i < 1000; i++) {
    const payload = { embeds: [{ title: 'Edit ' + i, color: 0xFF1493, image: { url } }] };
    preserveExistingEmbedBannerAttachment(message, payload, 0);
    assert.equal(payload.embeds[0].image.url, 'attachment://' + name);
    assert.deepEqual(payload.attachments, [{ id }]);
    assert.equal(payload.embeds[0].color, 0xFF1493);
    assert.equal(payload.files, undefined);
  }
});

