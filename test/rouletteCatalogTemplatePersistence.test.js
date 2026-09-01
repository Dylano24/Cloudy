import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';

import catalogUpdateEvent from '../src/events/systemEmbedCatalogMessageUpdate.js';
import { db } from '../src/utils/database.js';
import { decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';

function installTestStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
}

function catalogEmbed({ title, color, key }) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription('The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**')
    .setColor(color)
    .setAuthor({
      name: `Cloudy template key: ${key} || Cloudy context: gambling/roulette || Cloudy kind: embed`,
    });
}

test('edited Roulette lost catalog style is reused by the next slash reply in another channel', async () => {
  installTestStorage();
  const guildId = '910000000000000001';
  const oldEmbed = catalogEmbed({
    title: 'Roulette — You lost',
    color: 0xFEE75C,
    key: 'embed:899476a8',
  });
  const editedEmbed = catalogEmbed({
    title: 'Roulette — you lost',
    color: 0xED4245,
    key: 'embed:899476a8',
  });

  await catalogUpdateEvent.execute(
    { guildId, channelId: 'catalog-channel', embeds: [oldEmbed] },
    { guildId, channelId: 'catalog-channel', embeds: [editedEmbed] },
  );

  // saveGlobalEmbedTemplate is staged synchronously by the event, so this must
  // already see the new red style even while persistence finishes in background.
  const runtime = new EmbedBuilder()
    .setTitle('Roulette — You lost')
    .setDescription('The wheel landed on <:18:123456789012345678>\n**18 • Red**')
    .setColor(0xFEE75C)
    .addFields(
      { name: 'Your bet', value: '$10 on black', inline: true },
      { name: 'Result', value: 'Lost $10', inline: true },
      { name: 'Cash balance', value: '$8,996,908', inline: true },
    );

  const decorated = await decorateEmbedWithSavedTemplate(guildId, 'gambling-channel', runtime);
  const data = decorated.embed.toJSON();

  assert.equal(decorated.matched, true);
  assert.equal(data.color, 0xED4245);
  assert.equal(data.title, 'Roulette — you lost');
  assert.equal(data.fields[0].value, '$10 on black');
  assert.equal(data.fields[1].value, 'Lost $10');
  assert.equal(data.fields[2].value, '$8,996,908');
});
