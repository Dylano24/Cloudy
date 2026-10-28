// Fresh-process restart probe for test/embedBuilderCanonicalIdentity.test.js.
// It starts with empty in-memory/Redis caches, loads the same durable
// database contents and performs Cloudy's ClientReady Search warmup and
// registry reconciliation before querying Search. Without a state file
// argument (e.g. when collected by `node --test`) it does nothing.
import { readFileSync } from 'node:fs';

const stateFile = process.argv[2];
if (!stateFile) process.exit(0);

const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const { Collection, Embed } = await import('discord.js');
const { db } = await import('../../src/utils/database/wrapper.js');
const storage = new Map(state.storage);
db.get = async (key, fallback) => structuredClone(storage.get(key) ?? fallback);
db.set = async (key, value) => { storage.set(key, structuredClone(value)); return true; };
db.delete = async key => { storage.delete(key); return true; };

const builder = (await import('../../src/commands/Tools/embedbuilder.js')).default;
const { prewarmEmbedBuilderSearch } = await import('../../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js');
const { getEmbedRegistry, reconcileEmbedRegistry } = await import('../../src/services/embedRegistryService.js');

const bot = { id: '1500000000000000001' };
const owner = { id: '1500000000000000002' };
const messages = new Collection();
const guild = {
  id: state.guildId, roles: { everyone: { id: state.guildId } }, members: { me: bot },
  emojis: { cache: new Collection() },
  channels: { cache: new Collection(), async fetch(id) { return this.cache.get(String(id)) || null; } },
};
guild.client = { user: bot, guilds: { cache: new Collection([[guild.id, guild]]) }, isReady: () => true };
const channel = {
  id: state.channelId, guildId: guild.id, guild, name: 'general', type: 0, rawPosition: 0,
  isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
  messages: {
    cache: messages,
    async fetch(query) {
      const id = typeof query === 'string' ? query : query?.message;
      if (id) {
        const found = messages.get(String(id));
        if (!found) { const error = new Error('Unknown Message'); error.code = 10008; throw error; }
        return found;
      }
      return new Collection(messages);
    },
  },
};
guild.channels.cache.set(channel.id, channel);
for (const item of state.physical || []) {
  messages.set(item.id, {
    id: item.id, guildId: guild.id, guild, channelId: channel.id, channel, author: bot,
    client: guild.client, content: '', flags: { has: () => false },
    embeds: item.embeds.map(embed => new Embed(embed)), components: item.components || [],
  });
}

await prewarmEmbedBuilderSearch(guild);
await reconcileEmbedRegistry(guild);
await prewarmEmbedBuilderSearch(guild);

const search = {};
for (const query of state.queries || []) {
  let choices = [];
  await builder.autocomplete({
    guildId: guild.id, guild, client: guild.client, user: owner, member: { id: owner.id, user: owner },
    options: { getFocused: () => ({ name: 'search', value: query }) },
    async respond(value) { choices = value; },
  });
  search[query] = choices.map(choice => choice.value);
}
const records = (await getEmbedRegistry(guild.id))
  .filter(record => !record.detached)
  .map(record => ({ messageId: record.messageId, title: record.snapshot?.title || record.title }));
console.log('RESULT ' + JSON.stringify({ records, search }));
process.exit(0);
