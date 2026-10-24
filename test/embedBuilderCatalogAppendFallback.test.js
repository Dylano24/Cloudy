import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import {
  ensureSystemEmbedCatalogs,
  getBuiltInSystemCatalogCoverage,
  getSearchableSystemCatalogRecords,
} from '../src/services/systemEmbedCatalogService.js';
import {
  buildMatches,
  buildSearchChoices,
  filterEmbedBuilderSearchRecords,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const GUILD_ID = 'catalog-append-guild';
const values = new Map();

function resetDb() {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => {
      values.delete(key);
      return true;
    },
  };
}

function fakeDiscord({ uneditableLastMessage = false } = {}) {
  let nextId = 100000000000000000n;
  const messages = [];
  const client = { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { cache: new Map() } };

  function makeMessage({ embeds = [], failEdit = false } = {}) {
    const message = {
      id: String(nextId++),
      guildId: GUILD_ID,
      channelId: 'botlog',
      content: 'System & error embed templates',
      createdAt: new Date('2026-10-24T00:00:00.000Z'),
      editedAt: null,
      author: { id: 'bot' },
      client,
      embeds: embeds.map(embed => ({ ...embed, toJSON: () => ({ ...embed }) })),
      async edit(payload) {
        if (failEdit) throw new Error('DiscordAPIError[50005]: Cannot edit a message authored by another user');
        message.embeds = (payload.embeds || []).map(embed => {
          const data = embed?.toJSON ? embed.toJSON() : { ...embed };
          return { ...data, toJSON: () => ({ ...data }) };
        });
        return message;
      },
      async delete() {
        return message;
      },
    };
    return message;
  }

  const channel = {
    id: 'botlog',
    name: 'botlog',
    guildId: GUILD_ID,
    position: 0,
    parent: null,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async () => {
        const map = new Map(messages.slice().reverse().map(message => [message.id, message]));
        map.last = () => [...map.values()].at(-1);
        return map;
      },
    },
    send: async payload => {
      const message = makeMessage({
        embeds: (payload.embeds || []).map(embed => (embed?.toJSON ? embed.toJSON() : embed)),
      });
      messages.push(message);
      return message;
    },
  };

  const guild = {
    id: GUILD_ID,
    client,
    channels: { cache: new Map([['botlog', channel]]), fetch: async () => channel },
  };
  client.guilds.cache.set(GUILD_ID, guild);

  if (uneditableLastMessage) {
    const stale = makeMessage({ embeds: [{ title: 'Legacy row', description: 'Old catalog row' }], failEdit: true });
    messages.push(stale);
    values.set(`cloudy:system-embed-catalog:${GUILD_ID}`, [stale.id]);
  }

  return { client, guild, messages };
}

test('built-in Search responses are indexed even when the last catalog message cannot be edited', async () => {
  resetDb();
  const previousGuildId = process.env.GUILD_ID;
  process.env.GUILD_ID = GUILD_ID;
  const { client, guild, messages } = fakeDiscord({ uneditableLastMessage: true });

  try {
    await ensureSystemEmbedCatalogs(client);
  } finally {
    if (previousGuildId === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = previousGuildId;
  }

  const coverage = getBuiltInSystemCatalogCoverage(GUILD_ID);
  assert.equal(coverage.complete, true, JSON.stringify(coverage.missing));
  assert.ok(coverage.missing.every(entry => entry.key !== 'builder:removed'));
  assert.ok(messages.length > 1, 'a fresh catalog message must be started after the refused edit');
  assert.equal(messages[0].embeds.length, 1, 'the uneditable message is left untouched');

  const records = filterEmbedBuilderSearchRecords(
    guild,
    { id: 'owner' },
    getSearchableSystemCatalogRecords(GUILD_ID),
    { requireSend: true },
  );
  for (const query of ['removed from builder', 'deleted from builder']) {
    const matches = buildMatches(guild, records, query);
    const choices = buildSearchChoices(matches).map(choice => choice.name);
    assert.deepEqual(choices.filter(name => name === 'Removed from Builder'), ['Removed from Builder'], query);
    assert.equal(matches[0].document.title, 'Removed from Builder', query);
    assert.equal(String(matches[0].record.source), 'system-catalog');
  }
});
