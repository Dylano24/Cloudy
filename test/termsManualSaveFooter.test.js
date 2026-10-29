import assert from 'node:assert/strict';
import test from 'node:test';
import { stampTermsFooterOnSave, syncExistingTermsFooter } from '../src/services/termsWebsiteFooterService.js';

const original = { title: '📜 Terms of service', description: 'Saved text', color: 0xFFFFFF, footer: { text: '© Cloudy Inc. • Last updated 07 October 2026 • 18:17', icon_url: 'https://example.com/icon.png' } };

test('Terms title and emoji changes receive Amsterdam Save date without showing the time', () => {
  const next = { ...original, title: '✅ Updated conditions' };
  const result = stampTermsFooterOnSave(original, next, { now: new Date('2026-10-09T12:32:00Z') });
  assert.equal(result.footer.text, '© Cloudy Inc. • Last updated 09 October 2026');
  const later = stampTermsFooterOnSave(result, structuredClone(result), { channelId: '1533191366190829768', now: new Date('2026-10-10T13:45:00Z') });
  assert.equal(later.footer.text, '© Cloudy Inc. • Last updated 10 October 2026');
  assert.equal(result.footer.icon_url, original.footer.icon_url);
  assert.equal(result.description, original.description);
});

test('every Terms Save refreshes the date while unrelated embeds keep their footer', () => {
  const result = stampTermsFooterOnSave(original, structuredClone(original), { now: new Date('2026-10-09T12:32:00Z') });
  assert.equal(result.footer.text, '© Cloudy Inc. • Last updated 09 October 2026');
  const unrelated = { ...original, title: 'Privacy policy' };
  assert.deepEqual(stampTermsFooterOnSave(unrelated, { ...unrelated, description: 'Changed' }), { ...unrelated, description: 'Changed' });
});

test('Terms of sale and renamed Terms in their channel keep automatic dating on future Saves', () => {
  for (const title of ['Terms of sale', 'Store terms of sale']) {
    const before = { ...original, title };
    assert.match(stampTermsFooterOnSave(before, { ...before, description: 'Updated' }).footer.text, /^© Cloudy Inc\. • Last updated \d{2} [A-Za-z]+ \d{4}$/);
  }
  const renamed = { ...original, title: 'Updated conditions' };
  assert.notEqual(stampTermsFooterOnSave(renamed, { ...renamed, description: 'Changed' }, { channelId: '1533191366190829768' }).footer.text, original.footer.text);
  for (const channelId of ['1554538587075248139', '1554538589960802354']) {
    assert.equal(stampTermsFooterOnSave(renamed, structuredClone(renamed), { channelId, now: new Date('2026-10-09T12:32:00Z') }).footer.text, '© Cloudy Inc. • Last updated 09 October 2026');
  }
});

test('winter Save uses Amsterdam timezone and the previous UTC day correctly', () => {
  const result = stampTermsFooterOnSave(original, { ...original, description: 'Changed' }, { now: new Date('2026-12-31T23:05:00Z') });
  assert.equal(result.footer.text, '© Cloudy Inc. • Last updated 01 January 2027');
});

test('existing Terms messages remove only the last separator and time, preserving date and every other field', async () => {
  for (const title of ['Terms of service', 'Store terms of sale']) {
    const before = {
      ...original,
      title,
      fields: [{ name: 'Legal text', value: 'Keep every word and every field' }],
      footer: { ...original.footer, text: '© Cloudy Inc. • Last updated 23 October 2026 • 18:17' },
    };
    const sibling = { title: 'Different message', footer: { text: 'Untouched' } };
    const message = {
      embeds: [before, sibling],
      edits: 0,
      async edit({ embeds }) { this.edits++; this.embeds = embeds; },
    };
    assert.equal(await syncExistingTermsFooter(message, title), true);
    assert.equal(message.embeds[0].footer.text, '© Cloudy Inc. • Last updated 23 October 2026');
    assert.deepEqual(
      { ...message.embeds[0], footer: before.footer },
      before,
      'only footer text may change',
    );
    assert.equal(message.embeds[0].footer.icon_url, before.footer.icon_url);
    assert.deepEqual(message.embeds[1], sibling);
    assert.equal(await syncExistingTermsFooter(message, title), false);
    assert.equal(message.edits, 1, 'no repeat edit on the next restart');
  }
});

test('a renamed Terms message keeps automatic dating after its time has been removed', () => {
  const before = { ...original, title: 'Updated conditions',
    footer: { ...original.footer, text: '© Cloudy Inc. • Last updated 23 October 2026' } };
  const changed = stampTermsFooterOnSave(before, { ...before, description: 'New terms text' }, {
    channelId: '1533191366190829768', now: new Date('2026-10-29T10:10:00Z'),
  });
  assert.equal(changed.footer.text, '© Cloudy Inc. • Last updated 29 October 2026');
  assert.equal(changed.footer.icon_url, before.footer.icon_url);
});

test('real Builder Save stamps only the selected Terms embed even without content changes', async t => {
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
  assert.notEqual(message.embeds[0].footer.text, original.footer.text, 'even an unchanged Save refreshes the published date');
  state.title = '✅ Updated conditions';
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const savedFooter = message.embeds[0].footer.text;
  assert.notEqual(savedFooter, original.footer.text);
  assert.equal(state.bottomLine, savedFooter);
  assert.deepEqual(message.embeds[1].toJSON(), sibling);
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].footer.text, savedFooter);
});
