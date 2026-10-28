import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed, Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, peekEmbedRegistry } from '../src/services/embedRegistryService.js';
import { refreshSavedOwnerSearchRecord, buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';

test('Search replaces a stale Test snapshot with the actual edited Yess pink physical embed and stops offering Test', async t => {
  const guildId = 'saved-physical-search-latest-20261028';
  const channelId = '177777777777777771';
  const messageId = '177777777777777772';
  const old = {
    title: 'Test',
    description: 'Hahahwjjw\n\nsjsisijajaj\n\nshsjsjwjwjje',
    color: 0xffffff,
    thumbnail: { url: 'https://example.com/white-c.png' },
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
  const current = {
    ...old,
    title: 'Yess',
    color: 0xff0080,
    thumbnail: { url: 'https://example.com/cloudy-c-logo.png' },
  };
  const record = {
    guildId, channelId, messageId, embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    title: old.title, name: old.title, snapshot: old, components: [],
  };
  const registryKey = 'cloudy:embed-registry:' + guildId;
  const stored = new Map([[registryKey, [record]]]);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(stored.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    stored.set(key, structuredClone(value));
    return true;
  });
  const fetched = [];
  const channel = {
    id: channelId,
    name: 'general',
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async (id, options) => {
      fetched.push({ id, options });
      return message;
    } },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy' } },
    channels: { cache: new Collection([[channelId, channel]]) },
  };
  const message = {
    id: messageId, guildId, channelId, channel, guild,
    author: { id: 'cloudy' }, client: guild.client,
    embeds: [new Embed(current)], components: [],
    flags: { has: () => false }, createdAt: new Date('2026-10-28T07:12:00Z'),
  };

  const [stale] = await getEmbedRegistry(guildId);
  assert.equal(stale.snapshot.title, 'Test');
  assert.equal(buildSearchChoices(buildMatches(guild, [stale], 'test')).length, 1);

  const refreshed = await refreshSavedOwnerSearchRecord(guild, stale);
  assert.equal(refreshed.snapshot.title, 'Yess');
  assert.equal(refreshed.snapshot.color, 0xff0080);
  assert.equal(refreshed.snapshot.thumbnail.url, current.thumbnail.url);
  assert.deepEqual(fetched, [{ id: messageId, options: { force: true } }]);
  const [saved] = await getEmbedRegistry(guildId, { cached: true });
  assert.equal(saved.snapshot.title, 'Yess', 'registry must persist the actual edited title');
  assert.equal(saved.snapshot.color, 0xff0080);
  assert.equal(peekEmbedRegistry(guildId, { current: true })[0].snapshot.title, 'Yess');
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [saved], 'test')), []);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [saved], 'yess')).map(x => x.name), ['Yess']);

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, refreshed), true);
  assert.equal(state.title, 'Yess');
  assert.equal(state.sideColor, 0xff0080);
  assert.equal(state.modifyTarget.sourceEmbedData.thumbnail.url, current.thumbnail.url,
    'the original dark C logo must not be replaced by automatic branding');
});

test('Search never silently overwrites a saved manual snapshot after a transient Discord read failure', async t => {
  const record = {
    guildId: 'physical-search-failure-20261028',
    channelId: '177777777777777773',
    messageId: '177777777777777774', embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    snapshot: { title: 'My saved embed', color: 0x336699 }, components: [],
  };
  const channel = { messages: {
    fetch: async () => { throw new Error('Transient Discord outage'); },
  } };
  const guild = { id: record.guildId, channels: {
    cache: new Collection([[record.channelId, channel]]),
  } };
  t.mock.method(db, 'set', async () => assert.fail('No write on transient REST failure'));
  const result = await refreshSavedOwnerSearchRecord(guild, record);
  assert.equal(result, record);
});
