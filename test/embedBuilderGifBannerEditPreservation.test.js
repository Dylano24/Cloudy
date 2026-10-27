import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { preserveExistingEmbedBannerAttachment, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { db } from '../src/utils/database.js';

const channelId = '185555555555551111';
const gifId = '185555555555551113';
const gifName = 'cloudy-animation.gif';
const gifUrl = 'https://cdn.discordapp.com/attachments/' + channelId + '/' + gifId + '/' + gifName + '?ex=signed';
const makeAttachment = () => ({ id: gifId, name: gifName, url: gifUrl, proxyURL: gifUrl });
const makeMessage = () => ({
  embeds: [{ title: 'YES', description: 'Old text', image: { url: gifUrl } }],
  attachments: new Collection([[gifId, makeAttachment()]]),
});

test('text-only Save reuses the original GIF inside the embed instead of an external CDN URL', () => {
  const payload = { embeds: [{ title: 'YES2', description: 'Updated text', image: { url: gifUrl } }] };
  preserveExistingEmbedBannerAttachment(makeMessage(), payload, 0);
  assert.deepEqual(payload.attachments, [{ id: gifId }]);
  assert.equal(payload.embeds[0].image.url, 'attachment://' + gifName);
  assert.equal(payload.files, undefined);
  assert.equal(payload.embeds[0].title, 'YES2');
});

test('changing/removing media is untouched, including unrelated attachments', () => {
  const extra = { id: '185555555555551115', name: 'guide.pdf',
    url: 'https://cdn.discordapp.com/attachments/' + channelId + '/185555555555551115/guide.pdf' };
  const message = makeMessage();
  message.attachments.set(extra.id, extra);
  const replaced = { embeds: [{ title: 'YES2', image: { url: 'https://images.example.org/new.gif' } }] };
  preserveExistingEmbedBannerAttachment(message, replaced, 0);
  assert.equal('attachments' in replaced, false);
  assert.equal(replaced.embeds[0].image.url, 'https://images.example.org/new.gif');
  const cleared = { embeds: [{ title: 'YES2' }] };
  preserveExistingEmbedBannerAttachment(message, cleared, 0);
  assert.equal('attachments' in cleared, false);
});

test('a newly converted video upload does not retain the old GIF', () => {
  const payload = { embeds: [{ title: 'YES2', image: { url: 'attachment://new.gif' } }],
    files: [{ attachment: Buffer.from('GIF89a'), name: 'new.gif' }] };
  preserveExistingEmbedBannerAttachment(makeMessage(), payload, 0, { newUpload: true });
  assert.equal('attachments' in payload, false, 'existing upload behavior is preserved');
  assert.equal(payload.embeds[0].image.url, 'attachment://new.gif');
  assert.equal(payload.files.length, 1);
});

test('media hosted outside the message is not changed', () => {
  const message = { embeds: [{ title: 'Test', image: { url: 'https://example.org/banner.gif' } }],
    attachments: new Collection() };
  const payload = { embeds: [{ title: 'Test 2', image: { url: 'https://example.org/banner.gif' } }] };
  preserveExistingEmbedBannerAttachment(message, payload, 0);
  assert.equal('attachments' in payload, false);
});

test('Modify Save edits the title without detaching the original banner GIF', async t => {
  const guildId = 'gif-banner-modify-save-20261027';
  const stored = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(stored.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { stored.set(key, structuredClone(value)); return true; });
  const edits = [];
  const existingEmbed = new Embed({ title: 'YES', description: 'Existing body',
    color: 0xFFFFFF, image: { url: gifUrl } });
  const msg = {
    id: '185555555555551114', guildId, channelId, author: { id: 'bot' },
    embeds: [existingEmbed], attachments: new Collection([[gifId, makeAttachment()]]),
    flags: { has: () => false }, components: [], content: '',
    edit: async payload => {
      edits.push(payload);
      msg.embeds = payload.embeds.map(e => new Embed({ ...e, image: e.image?.url?.startsWith('attachment://')
        ? { url: gifUrl } : e.image }));
      return msg;
    },
  };
  const channel = { id: channelId, messages: { fetch: async () => msg } };
  msg.channel = channel;
  const guild = { id: guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channelId, channel]]) } };
  const state = { title: 'YES2', message: 'Existing body', embedFields: [],
    sideColor: 0xFFFFFF, showLogo: false, mediaUrl: gifUrl,
    modifyTarget: { guildId, channelId, messageId: msg.id, embedIndex: 0,
      source: 'embed-builder', sourceEmbedData: existingEmbed.toJSON(),
      previewSourceData: existingEmbed.toJSON(), templateMode: false } };
  const outcome = await saveModifiedEmbed(guild, state);
  assert.equal(outcome.ok, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].embeds[0].title, 'YES2');
  assert.equal(edits[0].embeds[0].image.url, 'attachment://' + gifName);
  assert.deepEqual(edits[0].attachments, [{ id: gifId }]);
  assert.equal(edits[0].files, undefined);
});
