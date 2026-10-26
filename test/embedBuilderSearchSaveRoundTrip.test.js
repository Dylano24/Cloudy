import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed, Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { getCachedSavedEmbedTemplateData, saveEmbedTemplateDecoration, decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';
import { buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { getEmbedRegistry, peekEmbedRegistry } from '../src/services/embedRegistryService.js';

function fixture(t, suffix) {
  const storage = new Map();
  const reads = [];
  t.mock.method(db, 'get', async (key, fallback) => {
    reads.push(key);
    return structuredClone(storage.get(key) ?? fallback);
  });
  t.mock.method(db, 'set', async (key, value) => {
    storage.set(key, structuredClone(value));
    return true;
  });
  const guildId = 'search-roundtrip-' + suffix;
  const channelId = '123456789012345671';
  const original = {
    title: 'Removed from Builder', description: 'The original removal notice.', color: 0xFFFFFF,
    fields: [{ name: 'Details', value: 'Original details', inline: true }],
    footer: { text: 'Original footer', icon_url: 'https://example.com/footer.png' },
    thumbnail: { url: 'https://example.com/logo.png' },
    image: { url: 'https://example.com/banner.png' },
    author: { name: 'Cloudy template key: source:roundtrip-notice || Cloudy context: embed-builder/delete || Cloudy kind: embed' },
  };
  const record = { guildId, channelId, messageId: '123456789012345672', embedIndex: 0,
    source: 'system-catalog', snapshot: original, title: original.title };
  const message = { id: record.messageId, guildId, channelId, author: { id: 'bot' },
    content: 'System & error embed templates', embeds: [new Embed(original)],
    flags: { has: () => false }, components: [] };
  message.edit = async payload => {
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  let fetches = 0;
  const channel = { id: channelId, name: 'botlog', guild: { id: guildId },
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Collection(), fetch: async () => { fetches++; return message; } } };
  message.channel = channel;
  const guild = { id: guildId, client: { user: { id: 'bot' } }, channels: { cache: new Collection([[channelId, channel]]) } };
  return { storage, reads, guild, record, original, message, fetches: () => fetches };
}

test('Search Save round trip keeps owner text, fields, footer and media through another Save', async t => {
  const { guild, record, original, storage } = fixture(t, 'content');
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  state.title = 'Removed from builder custom 🔨';
  state.message = 'The owner changed this notice.';
  state.embedFields = [{ name: 'Saved details', value: 'Owner details', inline: false }];
  state.bottomLine = 'Owner footer';
  state.mediaUrl = 'https://example.com/owner-banner.png';
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const reopened = {};
  loadRecordSnapshotIntoState(reopened, guild, record);
  assert.equal(reopened.title, state.title);
  assert.equal(reopened.message, state.message);
  assert.deepEqual(reopened.embedFields, state.embedFields);
  assert.equal(reopened.bottomLine, 'Owner footer');
  assert.equal(reopened.mediaUrl, 'https://example.com/owner-banner.png');
  reopened.sideColor = 0x123456;
  assert.equal((await saveModifiedEmbed(guild, reopened)).ok, true);
  const latest = getCachedSavedEmbedTemplateData(guild.id, record.channelId, original).data;
  assert.equal(latest.description, 'The owner changed this notice.');
  assert.equal(latest.footer.text, 'Owner footer');
  assert.equal(latest.image.url, 'https://example.com/owner-banner.png');
  const cold = await import('../src/services/embedTemplateService.js?search-save-restart');
  await cold.warmSavedEmbedTemplateScopes(guild.id, [record.channelId]);
  assert.equal(cold.getCachedSavedEmbedTemplateData(guild.id, record.channelId, original).data.title, state.title);
  assert.ok(storage.size > 0);
});

test('Search Save keeps owner-added numeric text in title and body instead of restoring the old source', async t => {
  const { guild, record, original } = fixture(t, 'literal-values');
  const state = {};
  loadRecordSnapshotIntoState(state, guild, record);
  state.title = 'Removed from builder version 2 <a:Rust:123456789012345678>';
  state.message = 'Owner notice version 2.';
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const saved = getCachedSavedEmbedTemplateData(guild.id, record.channelId, original).data;
  assert.equal(saved.title, state.title);
  assert.equal(saved.description, state.message);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [record], 'removed from builder')),
    [{ name: state.title, value: record.channelId + ':' + record.messageId + ':0' }]);
});

test('one Search Save reuses its live logo read instead of fetching the same message twice', async t => {
  const f = fixture(t, 'fetches');
  const state = {};
  loadRecordSnapshotIntoState(state, f.guild, f.record);
  state.message = 'Owner edit';
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  assert.equal(f.fetches(), 1);
});

test('confirmed Search Save publishes the persisted registry snapshot without a redundant final database read', async t => {
  const f = fixture(t, 'registry');
  const state = {};
  loadRecordSnapshotIntoState(state, f.guild, f.record);
  state.title = 'Saved removal notice';
  assert.equal((await saveModifiedEmbed(f.guild, state)).ok, true);
  const key = f.reads.find(key => key.startsWith('cloudy:embed-registry:'));
  assert.ok(key);
  assert.ok(f.reads.filter(read => read === key).length <= 2, 'registration should not reread the registry after its durable write');
  const known = peekEmbedRegistry(f.guild.id, { current: true });
  assert.equal(known.find(record => record.messageId === f.record.messageId).snapshot.title, state.title);
  await getEmbedRegistry(f.guild.id, { cached: true });
  assert.ok(f.reads.filter(read => read === key).length <= 2);
});

test('saved ticket-main claim examples never replace the next ticket unclaimed value', async t => {
  const { guild, record } = fixture(t, 'ticket-runtime-claim');
  assert.equal(await saveEmbedTemplateDecoration(guild.id, record.channelId, ['ticket-main', 'Ticket #123'], {
    title: 'Ticket #123', description: 'Ticket details',
    fields: [{ name: 'Claimed By', value: '<@123456789012345678>' }],
  }, { sharedScope: true, canonicalIdentity: 'ticket-main' }), true);
  const next = new Embed({ title: 'Ticket #456', description: 'Ticket details',
    fields: [{ name: 'Claimed By', value: 'Not claimed' }] });
  const output = await decorateEmbedWithSavedTemplate(guild.id, record.channelId, next);
  assert.equal(output.matched, true);
  assert.equal(output.embed.toJSON().fields[0].value, 'Not claimed');
  assert.equal(output.embed.toJSON().title, 'Ticket #456');
});
