import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';
import { getCanonicalBuilderRecords, loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { createEmbedColorPickerSession, applyEmbedColorPickerSession, deleteEmbedColorPickerSession } from '../src/services/embedColorPickerSessionService.js';

function fixture(id) {
  const stored = new Map(), messages = new Collection();
  const storage = { get: async key => structuredClone(stored.get(key) || null), set: async (key, value) => { stored.set(key, structuredClone(value)); return true; }, list: async prefix => [...stored.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage };
  const guild = { id, client, channels: { cache: new Collection() } };
  let historyReads = 0;
  const channel = { id: `${id}-appeal-form`, guild, client, name: 'appeal-form', type: 0, isTextBased: () => true, toString: () => '#appeal-form' };
  guild.channels.cache.set(channel.id, channel);
  channel.messages = { cache: messages, fetch: async arg => {
    if (typeof arg === 'string') return messages.get(arg);
    historyReads++; return new Collection([...messages].sort(([a], [b]) => b.localeCompare(a)));
  }, edit: async (messageId, payload) => messages.get(messageId).edit(payload) };
  function add(messageId, body, createdAt) {
    const message = { id: messageId, guildId: id, guild, client, channelId: channel.id, channel, author: client.user, flags: { has: () => false }, content: '', editable: true, createdAt: new Date(createdAt), createdTimestamp: createdAt, components: [],
      embeds: [new Embed({ title: 'Appeal form', description: body, color: 0xFFFFFF, footer: { text: 'Cloudy footer' } })],
      async edit(payload) { this.embeds = payload.embeds.map(e => new Embed(e.toJSON?.() || e)); return this; } };
    messages.set(messageId, message); return message;
  }
  const record = message => ({ guildId: id, channelId: channel.id, messageId: message.id, embedIndex: 0, source: 'embed-builder', createdAt: message.createdAt.toISOString(), snapshot: message.embeds[0].toJSON() });
  return { guild, channel, messages, stored, add, record, historyReads: () => historyReads };
}

test('channel selects newest real appeal panel, Save updates it and fixed-text duplicates, reopen sees saved contents', async () => {
  const f = fixture('complete-appeal-panel');
  const older = f.add('100', 'Older explanation\n\n**Appeal here:** [Submit an Appeal]', 1000);
  const newest = f.add('200', 'Current explanation\n\n**Appeal here:** https://example.com/appeal', 2000);
  const records = [f.record(newest), f.record(older)];
  f.stored.set(`cloudy:embed-registry:${f.guild.id}`, records);
  const [selected] = await getCanonicalBuilderRecords(f.guild, records, { perChannel: true });
  assert.equal(selected.messageId, newest.id);
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, f.guild, selected, selected.previewRecord, selected.sourceRecord), true);
  assert.match(state.message, /Current explanation/);
  state.title = '<:bird:1543303473645228123> Appeal form';
  state.message = 'My saved explanation\n\n**Appeal here:** [Cloudy appeal form](https://cloudy-store-vert.vercel.app/appeal)';
  state.embedFields = [{ name: 'Evidence', value: 'Screenshots and videos', inline: false }];
  state.bottomLine = 'Cloudy footer'; state.mediaUrl = 'https://example.com/guide.png';
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  assert.equal(newest.embeds[0].title, state.title);
  assert.equal(newest.embeds[0].description, state.message);
  for (let i = 0; i < 20 && older.embeds[0].description !== state.message; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(older.embeds[0].description, state.message);
  assert.equal(older.embeds[0].fields[0].value, 'Screenshots and videos');
  assert.equal(newest.embeds[0].fields[0].value, 'Screenshots and videos');
  assert.equal(newest.embeds[0].image.url, state.mediaUrl);
  const [reopened] = await getCanonicalBuilderRecords(f.guild, null, { perChannel: true });
  assert.equal(reopened.snapshot.description, state.message);
  assert.equal(reopened.snapshot.title, state.title);
  assert.equal(f.historyReads(), 0);
});

test('Save drains editor typing immediately, before its coalescing timer runs', async () => {
  const f = fixture('immediate-editor-save');
  const message = f.add('300', 'Original text', 3000);
  const state = { title: 'Appeal form', message: 'Original text', sideColor: 0xFFFFFF, embedFields: [], bottomLine: 'Cloudy footer', modifyTarget: { channelId: f.channel.id, messageId: message.id, embedIndex: 0, source: 'embed-builder', sourceEmbedData: message.embeds[0].toJSON(), cachedMessage: message, templateMode: false } };
  const token = createEmbedColorPickerSession({ userId: 'owner', getEditorState: () => state, onEditorUpdate: async (field, value) => { if (field === 'title') state.title = value; if (field === 'message') state.message = value; } });
  state.colorSessionToken = token;
  try {
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'First draft' }));
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Final title' }));
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'message', value: 'Final text' }));
    assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
    assert.equal(message.embeds[0].title, 'Final title');
    assert.equal(message.embeds[0].description, 'Final text');
  } finally { deleteEmbedColorPickerSession(token); }
});

test('channel discovery fetches one page and drops deleted cached embeds on the next refresh', async () => {
  const f = fixture('fresh-discovery');
  f.add('400', 'Old panel', 4000);
  assert.equal((await discoverRecentChannelEmbeds(f.guild, f.channel.id, 'bot')).length, 1);
  f.messages.clear();
  assert.equal((await discoverRecentChannelEmbeds(f.guild, f.channel.id, 'bot')).length, 0);
  f.add('500', 'New panel', 5000);
  assert.equal((await discoverRecentChannelEmbeds(f.guild, f.channel.id, 'bot'))[0].messageId, '500');
  assert.equal(f.historyReads(), 3);
});

