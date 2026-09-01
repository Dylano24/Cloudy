import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';

import { db } from '../src/utils/database.js';
import {
  decorateEmbedWithSavedTemplate,
  saveEmbedTemplateDecoration,
} from '../src/services/embedTemplateService.js';

function installBlockingStorage({ blockFirstSet = false } = {}) {
  const values = new Map();
  let setCount = 0;
  let releaseFirstSet;
  let firstSetStarted;

  const firstSetStartedPromise = new Promise(resolve => {
    firstSetStarted = resolve;
  });
  const firstSetGate = new Promise(resolve => {
    releaseFirstSet = resolve;
  });

  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      setCount += 1;
      if (blockFirstSet && setCount === 1) {
        firstSetStarted();
        await firstSetGate;
      }
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };

  return {
    values,
    firstSetStartedPromise,
    releaseFirstSet,
  };
}

function rouletteEmbed() {
  return new EmbedBuilder()
    .setTitle('Roulette — You lost')
    .setDescription('The wheel landed on 17\n**17 • Black**')
    .setColor(0xFEE75C)
    .addFields(
      { name: 'Your bet', value: '**$100** on **red**', inline: true },
      { name: 'Result', value: 'Lost **$100**', inline: true },
      { name: 'Cash balance', value: '**$900**', inline: true },
    );
}

test('new roulette template is visible before DB persistence finishes', async () => {
  const storage = installBlockingStorage({ blockFirstSet: true });
  const guildId = '810000000000000001';
  const channelId = '820000000000000001';

  const savePromise = saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Roulette — You lost'],
    {
      title: 'Roulette — You lost',
      color: 0xFFFFFF,
      footer: { text: 'Cloudy • Build. Compete. Dominate.' },
    },
  );

  await storage.firstSetStartedPromise;

  const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, rouletteEmbed());
  const data = decorated.embed.toJSON();

  assert.equal(decorated.matched, true);
  assert.equal(data.color, 0xFFFFFF);
  assert.equal(data.footer.text, 'Cloudy • Build. Compete. Dominate.');
  assert.equal(data.description, 'The wheel landed on 17\n**17 • Black**');
  assert.deepEqual(data.fields.map(field => field.value), [
    '**$100** on **red**',
    'Lost **$100**',
    '**$900**',
  ]);

  storage.releaseFirstSet();
  assert.equal(await savePromise, true);
});

test('newest queued template wins while an older save is still persisting', async () => {
  const storage = installBlockingStorage({ blockFirstSet: true });
  const guildId = '810000000000000002';
  const channelId = '820000000000000002';

  const firstSave = saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Roulette — You lost'],
    {
      title: 'Roulette — You lost',
      color: 0x111111,
      footer: { text: 'Older style' },
    },
  );

  await storage.firstSetStartedPromise;

  const secondSave = saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Roulette — You lost'],
    {
      title: 'Roulette — You lost',
      color: 0xFFFFFF,
      footer: { text: 'Newest style' },
    },
  );

  const duringRace = await decorateEmbedWithSavedTemplate(guildId, channelId, rouletteEmbed());
  assert.equal(duringRace.embed.toJSON().color, 0xFFFFFF);
  assert.equal(duringRace.embed.toJSON().footer.text, 'Newest style');

  storage.releaseFirstSet();
  assert.equal(await firstSave, true);
  assert.equal(await secondSave, true);

  const afterPersistence = await decorateEmbedWithSavedTemplate(guildId, channelId, rouletteEmbed());
  assert.equal(afterPersistence.embed.toJSON().color, 0xFFFFFF);
  assert.equal(afterPersistence.embed.toJSON().footer.text, 'Newest style');
});
