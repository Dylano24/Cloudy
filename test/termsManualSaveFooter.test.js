import assert from 'node:assert/strict';
import test from 'node:test';
import { stampTermsFooterOnSave, syncExistingTermsFooter } from '../src/services/termsWebsiteFooterService.js';

const original = { title: '📜 Terms of service', description: 'Saved text', color: 0xFFFFFF, footer: { text: '© Cloudy Inc. • Last updated 07 October 2026 • 18:17', icon_url: 'https://example.com/icon.png' } };

test('Terms title and emoji changes receive Amsterdam Save date and time with the same footer layout', () => {
  const next = { ...original, title: '✅ Updated conditions' };
  const result = stampTermsFooterOnSave(original, next, { now: new Date('2026-10-09T12:32:00Z') });
  assert.equal(result.footer.text, '© Cloudy Inc. • Last updated 09 October 2026 • 14:32');
  assert.equal(result.footer.icon_url, original.footer.icon_url);
  assert.equal(result.description, original.description);
});

test('unchanged Save and unrelated embeds keep their footer', () => {
  assert.deepEqual(stampTermsFooterOnSave(original, structuredClone(original)), original);
  const unrelated = { ...original, title: 'Privacy policy' };
  assert.deepEqual(stampTermsFooterOnSave(unrelated, { ...unrelated, description: 'Changed' }), { ...unrelated, description: 'Changed' });
});

test('Terms of sale and renamed Terms in their channel keep automatic dating on future Saves', () => {
  for (const title of ['Terms of sale', 'Store terms of sale']) {
    const before = { ...original, title };
    assert.match(stampTermsFooterOnSave(before, { ...before, description: 'Updated' }).footer.text, /^© Cloudy Inc\. • Last updated \d{2} [A-Za-z]+ \d{4} • \d{2}:\d{2}$/);
  }
  const renamed = { ...original, title: 'Updated conditions' };
  assert.notEqual(stampTermsFooterOnSave(renamed, { ...renamed, description: 'Changed' }, { channelId: '1533191366190829768' }).footer.text, original.footer.text);
});

test('winter Save uses Amsterdam timezone and the previous UTC day correctly', () => {
  const result = stampTermsFooterOnSave(original, { ...original, description: 'Changed' }, { now: new Date('2026-12-31T23:05:00Z') });
  assert.equal(result.footer.text, '© Cloudy Inc. • Last updated 01 January 2027 • 00:05');
});

test('startup reconciliation never overwrites a manually dated Discord Terms footer', async () => {
  const message = { embeds: [original], edit: async () => { assert.fail('must preserve saved date'); } };
  assert.equal(await syncExistingTermsFooter(message, 'Terms of service'), false);
});

test('real Builder Save stamps only the selected Terms embed and a second unchanged Save preserves it', async t => {
  const { Embed } = await import('discord.js');
  const { db } = await import('../src/utils/database.js');
  const { loadRecordSnapshotIntoState, saveModifiedEmbed } = await import('../src/services/embedManagerService.js');
  const oldDb = { initialized: db.initialized, useFallback: db.useFallback, db: db.db };
  t.after(() => Object.assign(db, oldDb));
  const kv = new Map();
  Object.assign(db, { initialized: true, useFallback: false, db: {
    get: async key => kv.get(key) ?? null,
    set: async (key, value) => { kv.set(key, structuredClone(value)); return true; },
    delete: async key => kv.delete(key),
    list: async prefix => [...kv.keys()].filter(key => key.startsWith(prefix)),
  } });
  const sibling = { title: 'Information', footer: { text: 'Keep this footer' } };
  const channel = { id: '1533191366190829768', name: 'terms-of-service' };
  const message = {
    id: 'terms-save-test', guildId: 'terms-save-guild', channelId: channel.id, channel,
    author: { id: 'bot' }, flags: { has: () => false }, components: [],
    embeds: [new Embed(original), new Embed(sibling)],
    async edit(payload) { this.embeds = payload.embeds.map(data => new Embed(data)); return this; },
  };
  channel.messages = { cache: new Map([[message.id, message]]), fetch: async () => message };
  const guild = { id: message.guildId, client: { user: { id: 'bot' } }, channels: { cache: new Map([[channel.id, channel]]), fetch: async () => channel } };
  const state = {};
  loadRecordSnapshotIntoState(state, guild, { guildId: guild.id, channelId: channel.id, messageId: message.id, source: 'embed-builder', embedIndex: 0, snapshot: original });
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].footer.text, original.footer.text, 'unchanged first Save must retain published date');
  state.title = '✅ Updated conditions';
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const savedFooter = message.embeds[0].footer.text;
  assert.notEqual(savedFooter, original.footer.text);
  assert.equal(state.bottomLine, savedFooter);
  assert.deepEqual(message.embeds[1].toJSON(), sibling);
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].footer.text, savedFooter);
});
