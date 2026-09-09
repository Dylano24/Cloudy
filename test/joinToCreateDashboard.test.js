import test from 'node:test';
import assert from 'node:assert/strict';
import command from '../src/commands/JoinToCreate/jointocreate.js';
import captureReady from '../src/events/systemEmbedCaptureReady.js';
import { runWithTraceContext } from '../src/utils/logger.js';
import {
  applyRuntimeEmbedTemplateData,
  primeSystemEmbedTemplateData,
  getSystemEmbedTemplateKey,
} from '../src/services/systemEmbedCatalogService.js';

test('dashboard opens with persisted modal value despite a stale catalog, and Submit survives reopening', async () => {
  const context = 'botlog/jointocreate';
  const title = 'Join to create configuration';
  const catalog = {
    title, description: 'Configuration for <#trigger>', color: 0x123456,
    fields: [
      { name: 'Channel name template', value: '`OLD catalog name`', inline: false },
      { name: 'User limit', value: 'Unlimited', inline: true },
      { name: 'Bitrate', value: '64 kbps', inline: true },
    ],
    footer: { text: 'Saved footer' },
  };
  assert.equal(primeSystemEmbedTemplateData(
    getSystemEmbedTemplateKey('embed', title, catalog.description, context), context, catalog,
  ), true);
  captureReady.execute();

  let stored = {
    triggerChannels: ['trigger'], channelNameTemplate: 'OLD guild default',
    channelOptions: { trigger: { nameTemplate: '{username} vocal', userLimit: 0, bitrate: 64000 } },
  };
  const client = { guilds: { cache: new Map(), fetch: async () => null }, db: {
    get: async key => {
      assert.equal(key, 'guild:guild:jointocreate');
      return structuredClone(stored);
    },
    set: async (key, value) => {
      assert.equal(key, 'guild:guild:jointocreate');
      stored = structuredClone(value);
    },
  } };
  const trigger = { id: 'trigger', guild: { id: 'guild' }, toString: () => '<#trigger>' };
  const member = { permissions: { has: () => true } };
  let payload;
  let collect;
  const serialize = data => {
    payload = { ...data, embeds: data.embeds.map(embed => applyRuntimeEmbedTemplateData(
      embed.toJSON ? embed.toJSON() : embed, { commandName: 'jointocreate' },
    )) };
  };
  const message = {
    components: [], edit: async data => serialize(data),
    createMessageComponentCollector: () => ({ on: (event, handler) => { if (event === 'collect') collect = handler; } }),
  };
  const open = async () => {
    const interaction = {
      id: 'interaction', user: { id: 'user' }, member, guild: trigger.guild,
      options: { getSubcommand: () => 'dashboard', getChannel: () => trigger },
      deferred: true, editReply: async data => serialize(data), fetchReply: async () => message,
    };
    await runWithTraceContext({ command: 'jointocreate' }, () => command.execute(interaction, {}, client));
    return structuredClone(payload.embeds[0]);
  };

  const initial = await open();
  assert.equal(initial.fields[0].value, '`{username} vocal`');
  assert.deepEqual(initial.fields.slice(1), catalog.fields.slice(1));
  assert.equal(initial.color, catalog.color);
  assert.deepEqual(initial.footer, catalog.footer);
  assert.equal(payload.components[0].components.length, 4);

  let prefill;
  await collect({
    customId: 'jtc_config_name_trigger', user: { id: 'user' }, member, guild: trigger.guild,
    showModal: async modal => { prefill = modal.toJSON().components[0].components[0].value; },
    awaitModalSubmit: async () => ({
      member, deferred: true, fields: { getTextInputValue: () => '{username} NEW' },
      editReply: async data => serialize(data), followUp: async () => null,
    }),
  });
  assert.equal(prefill, '{username} vocal');
  assert.equal(stored.channelOptions.trigger.nameTemplate, '{username} NEW');
  assert.equal(payload.embeds[0].fields[0].value, '`{username} NEW`');
  assert.equal((await open()).fields[0].value, '`{username} NEW`');

  delete stored.channelOptions.trigger.nameTemplate;
  assert.equal((await open()).fields[0].value, '`OLD guild default`');
  delete stored.channelNameTemplate;
  assert.equal((await open()).fields[0].value, "`{username}'s Room`");
});
