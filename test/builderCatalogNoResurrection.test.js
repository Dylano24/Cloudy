import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import {
  captureSystemEmbedData,
  ensureSystemEmbedCatalogs,
  getSystemEmbedTemplateKey,
  rememberCatalogSourceEvidence,
  resetSystemEmbedCatalogInitialization,
} from '../src/services/systemEmbedCatalogService.js';
import { loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { definitionSourcePath } from '../src/config/builderCatalogManifest.js';

// Builder admission (owner's choice): the catalog never (re)creates unchanged
// TitanBot examples or retired command templates; old ones stay in Discord but
// out of the Builder, also after a restart or after their code is removed.
const GUILD_ID = 'no-resurrection-guild';
const values = new Map();
const author = (title, context, description = '') => ({
  name: `Cloudy template key: ${getSystemEmbedTemplateKey('embed', title, description, context)} || Cloudy context: ${context} || Cloudy kind: embed`,
});

function resetDb() {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => { values.delete(key); return true; },
  };
}

function fakeDiscord() {
  let nextId = 300000000000000000n;
  const messages = [];
  const client = { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { cache: new Map() } };
  const wrap = data => ({ ...data, toJSON: () => structuredClone(data) });
  const makeMessage = embeds => {
    const message = {
      id: String(nextId++), guildId: GUILD_ID, channelId: 'botlog', content: 'System & error embed templates',
      createdAt: new Date('2026-11-01T00:00:00.000Z'), editedAt: null, author: { id: 'bot' }, client,
      embeds: embeds.map(wrap),
      async edit(payload) {
        message.embeds = (payload.embeds || []).map(embed => wrap(embed?.toJSON ? embed.toJSON() : { ...embed }));
        return message;
      },
      async delete() { throw new Error('the catalog test never deletes a Discord message'); },
    };
    return message;
  };
  let failFetch = false;
  const channel = {
    id: 'botlog', name: 'botlog', guildId: GUILD_ID, type: 0, position: 0, parent: null,
    isTextBased: () => true, isSendable: () => true, permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        if (failFetch) throw new Error('Discord 500');
        const map = new Map(messages.slice().reverse().map(message => [message.id, message]));
        map.last = () => [...map.values()].at(-1);
        return map;
      },
    },
    send: async payload => {
      const message = makeMessage((payload.embeds || []).map(embed => (embed?.toJSON ? embed.toJSON() : embed)));
      messages.push(message);
      return message;
    },
  };
  const guild = { id: GUILD_ID, client, members: { me: null },
    channels: { cache: new Map([['botlog', channel]]), fetch: async () => channel } };
  client.guilds.cache.set(GUILD_ID, guild);
  return { client, guild, messages, makeMessage, setFailFetch: value => { failFetch = value; } };
}

const titles = messages => messages.flatMap(message => message.embeds.map(embed => String(embed.title || '')));
const searchTitles = async guild => (await loadFastEmbedBuilderSearchRecords(
  { guild, guildId: guild.id, member: null }, { unfiltered: true },
)).map(record => String(record.snapshot?.title || record.title || ''));

let fixture;

test('the catalog creates Cloudy templates, never unchanged TitanBot or retired examples; old ones stay but leave the Builder', async () => {
  resetDb();
  const previous = process.env.GUILD_ID;
  process.env.GUILD_ID = GUILD_ID;
  fixture = fakeDiscord();
  const { client, guild, messages, makeMessage } = fixture;
  // A catalog from an older release that still holds old examples, and one the owner saved.
  const old = makeMessage([
    { title: 'Task Added', description: 'Old todo example', author: author('Task Added', 'botlog/todo') },
    { title: '🏆 Duel Complete!', description: 'Old fight example', author: author('🏆 Duel Complete!', 'gambling/fight') },
    { title: '⚔️ Invalid Challenge', description: 'My own saved text', author: author('⚔️ Invalid Challenge', 'gambling/fight') },
  ]);
  messages.push(old);
  values.set(`cloudy:system-embed-catalog:${GUILD_ID}`, [old.id]);
  values.set(`cloudy:embed-registry:${GUILD_ID}`, [{
    guildId: GUILD_ID, channelId: 'botlog', backingChannelId: 'botlog', messageId: old.id, embedIndex: 2,
    source: 'system-catalog', manualSaved: true, explicitSave: true, title: '⚔️ Invalid Challenge',
    snapshot: old.embeds[2].toJSON(), createdAt: '2026-10-01T00:00:00.000Z',
  }]);
  try {
    await ensureSystemEmbedCatalogs(client);
  } finally {
    if (previous === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previous;
  }

  const created = titles(messages);
  for (const title of ['Manage giveaway', 'Robbery successful', 'Robbery failed', 'Removed from Builder']) {
    assert.ok(created.includes(title), `created: ${title}`);
  }
  for (const title of ['Welcome Image Updated', 'Shared List Created', 'Heads or Tails', 'Fishing Success']) {
    assert.ok(!created.some(item => item.includes(title)), `never created: ${title}`);
  }
  assert.deepEqual(titles([old]).slice(0, 3), ['Task Added', '🏆 Duel Complete!', '⚔️ Invalid Challenge'],
    'the old entries are untouched (new ones may follow them in the same message)');

  const decisions = values.get(`cloudy:embed-builder-catalog-policy:${GUILD_ID}`)?.decisions || {};
  const todoFamily = `botlog/todo|${getSystemEmbedTemplateKey('embed', 'Task Added', '', 'botlog/todo')}`;
  assert.equal(decisions[todoFamily]?.decision, 'archive', 'the decision is recorded');

  await getEmbedRegistry(GUILD_ID, { cached: true });
  const listed = await searchTitles(guild);
  assert.ok(listed.includes('⚔️ Invalid Challenge'), 'the owner-saved retired template stays');
  assert.ok(listed.includes('Manage giveaway'));
  assert.ok(!listed.includes('Task Added'), 'unchanged todo example is out of the Builder');
  assert.ok(!listed.includes('🏆 Duel Complete!'), 'retired fight example is out of the Builder');
});

test('a second start creates nothing new and a removed source does not bring an archived example back', async () => {
  const { client, guild, messages } = fixture;
  const before = titles(messages).length;
  const previous = process.env.GUILD_ID;
  process.env.GUILD_ID = GUILD_ID;
  try {
    resetSystemEmbedCatalogInitialization({ forgetBuilderDecisions: true });
    await ensureSystemEmbedCatalogs(client);
  } finally {
    if (previous === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previous;
  }
  assert.equal(titles(messages).length, before, 'no new catalog entries after a restart');

  // The todo code disappears (file renamed or removed): its recorded decision still applies.
  const withoutTodo = (await discoverEmbedDefinitions())
    .filter(definition => !definitionSourcePath(definition).endsWith('Utility/todo.js'));
  rememberCatalogSourceEvidence(withoutTodo, { retiredFamilies: new Set() });
  const listed = await searchTitles(guild);
  assert.ok(!listed.includes('Task Added'), 'still archived after its source is gone');
  assert.ok(listed.includes('⚔️ Invalid Challenge'), 'own work is still listed');
});

test('a reply of a retired or unknown feature never teaches the catalog a new template', async () => {
  const { messages } = fixture;
  const before = titles(messages).length;
  assert.equal(captureSystemEmbedData({ title: 'Brand new duel result', description: 'x won' },
    { guildId: GUILD_ID, commandName: 'fight' }), false, 'a retired command is not queued');
  captureSystemEmbedData({ title: 'Something only sent once', description: 'y' },
    { guildId: GUILD_ID, commandName: 'todo', channel: { name: 'general' } });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(titles(messages).length, before);
  assert.ok(!titles(messages).includes('Something only sent once'));
});

test('an unreadable catalog is never forgotten or added twice', async () => {
  const { client, messages, setFailFetch } = fixture;
  const ids = values.get(`cloudy:system-embed-catalog:${GUILD_ID}`);
  const before = titles(messages).length;
  const previous = process.env.GUILD_ID;
  process.env.GUILD_ID = 'another-guild';
  setFailFetch(true);
  try {
    resetSystemEmbedCatalogInitialization();
    await ensureSystemEmbedCatalogs(client).catch(() => null);
  } finally {
    setFailFetch(false);
    if (previous === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previous;
  }
  assert.deepEqual(values.get(`cloudy:system-embed-catalog:${GUILD_ID}`), ids, 'the stored catalog IDs are kept');
  assert.equal(titles(messages).length, before, 'nothing was created on top of an unread catalog');
});
