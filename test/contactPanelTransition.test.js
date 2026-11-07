import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { getGuildConfigKey } from '../src/utils/database/keys.js';
import { applyTicketPanelPresentation } from '../src/services/ticketPanelPresentation.js';
import * as panels from '../src/services/ticketPanelBuilder.js';

const transition = await import('../src/services/ticketPanelTransitionService.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

let index = 0;
function world(t, {rejectConfig = false} = {}) {
  const guildId = String(1800000000000000000n + BigInt(++index));
  const channelId = '1800000000000000001';
  const emoji = {id: '1800000000000000099', name: 'cloudy_support_bot_white', animated: false};
  const values = new Map([[getGuildConfigKey(guildId), {ticketPanelChannelId: channelId,
    ticketPanelMessageId: '1800000000000000002', ticketFaqChannelId: '1554538586001645679',
    ticketPanelTitle: 'Old title', ticketPanelMessage: 'Old body', ticketStaffRoleId: 'staff-role',
    ticketCategoryId: 'tickets-category', maxTicketsPerUser: 1}]]);
  const writes = [];
  const storage = {get: async (key, fallback = null) => structuredClone(values.get(key) ?? fallback),
    set: async (key, value) => {if (rejectConfig && key === getGuildConfigKey(guildId)) return false;
      writes.push(key); values.set(key, structuredClone(value)); return true;}};
  t.mock.method(db, 'get', storage.get);
  t.mock.method(db, 'set', storage.set);
  const client = {user: {id: 'cloudy-bot'}, db: storage,
    application: {emojis: {cache: new Collection([[emoji.id, emoji]]), fetch: async () => new Collection([[emoji.id, emoji]])}},
    channels: {cache: new Collection()}, guilds: {cache: new Collection()}};
  const guild = {id: guildId, client, channels: {cache: new Collection()}};
  const channel = {id: channelId, guildId, guild, name: 'contact-us', isTextBased: () => true,
    messages: {fetch: async id => id === old.id ? old : target}};
  guild.channels.cache.set(channelId, channel);
  client.guilds.cache.set(guildId, guild);
  const message = (id, embed, components) => ({id, guildId, channelId, channel, guild, client,
    author: client.user, editable: true, createdAt: new Date('2026-11-07T08:33:00Z'),
    embeds: [new Embed(embed)], components, edits: [],
    async edit(payload) {
      this.edits.push(structuredClone(payload));
      assert.deepEqual(Object.keys(payload), ['components'], 'only controls may be edited');
      // Discord adds component IDs/defaults and returns fields in its own order.
      this.components = structuredClone(payload.components).map((row, rowIndex) => ({...row, id: rowIndex + 1,
        components: row.components.map((button, buttonIndex) => ({disabled: false, ...button, id: buttonIndex + 1,
          ...(button.emoji ? {emoji: {animated: false, ...button.emoji}} : {})}))}));
      return this;
    }});
  const old = message('1800000000000000002', {title: 'Contact the staff team', description: 'Old FAQ text'},
    [{type: 1, components: [{type: 2, custom_id: 'create_ticket', label: 'Start chat', style: 2, emoji: {name: '💬'}},
      {type: 2, label: '❔FAQ', style: 5, url: `https://discord.com/channels/${guildId}/1534654577385672917`}]}]);
  const target = message('1800000000000000003', {title: '<:shield_white:1800000000000000010> Contact the staff team',
    description: 'Keep  this spacing.\n\nOur **Support assistant** helps you.', color: 0x123456,
    footer: {text: '© Cloudy Inc. • Quality. Innovation. Performance.\u200b'},
    image: {url: 'https://example.test/original.gif'}, fields: [{name: 'My field', value: 'Original value'}]}, []);
  return {client, guild, old, target, values, writes, guildId};
}

function transfer(...args) {
  assert.equal(typeof transition.transferTicketPanelControls, 'function', 'Missing explicit panel transfer');
  return transition.transferTicketPanelControls(...args);
}

test('automatic panel presentation cannot replace the shield embed after controls are attached', async t => {
  const w = world(t);
  w.target.components = [{components: [{customId: 'create_ticket', label: 'Start chat'}]}];
  const before = w.target.embeds[0].toJSON();
  await applyTicketPanelPresentation(w.target);
  assert.deepEqual(w.target.embeds[0].toJSON(), before);
  assert.equal(w.target.edits.length, 0);
});

test('contact controls keep Start chat and the white-bot Support assistant link', t => {
  const w = world(t);
  assert.equal(typeof panels.buildTicketPanelComponents, 'function');
  const rows = panels.buildTicketPanelComponents(w.client, w.guildId, {}, w.old.components).map(row => row.toJSON());
  assert.equal(rows[0].components[0].custom_id, 'create_ticket');
  assert.equal(rows[0].components[0].label, 'Start chat');
  assert.equal(rows[0].components[0].emoji.name, '💬');
  assert.equal(rows[0].components[1].label, 'Support assistant');
  assert.equal(rows[0].components[1].emoji.id, '1800000000000000099');
  assert.equal(rows[0].components[1].url, `https://discord.com/channels/${w.guildId}/1554538586001645679`);
  assert.equal(rows[0].components.length, 2);
});

test('a dry run plans the exact message transfer without editing Discord, config or the registry', async t => {
  const w = world(t);
  const result = await transfer(w.client, {source: w.old, target: w.target});
  assert.equal(result.applied, false);
  assert.equal(result.targetMessageId, w.target.id);
  assert.equal(w.target.edits.length, 0);
  assert.deepEqual(w.writes, []);
});

test('explicit transfer keeps the message and full embed intact and records its functional controls for Builder', async t => {
  const w = world(t);
  const before = w.target.embeds[0].toJSON();
  const result = await transfer(w.client, {source: w.old, target: w.target}, {apply: true});
  assert.equal(result.applied, true);
  assert.deepEqual(w.target.embeds[0].toJSON(), before);
  assert.equal(w.target.edits.length, 1);
  assert.equal(w.old.edits.length, 0, 'the old message is preserved');
  const config = w.values.get(getGuildConfigKey(w.guildId));
  assert.equal(config.ticketPanelMessageId, w.target.id);
  assert.equal(config.ticketPanelTitle, before.title);
  assert.equal(config.ticketPanelMessage, before.description);
  assert.equal(config.maxTicketsPerUser, 1);
  assert.equal(config.ticketStaffRoleId, 'staff-role');
  assert.equal(config.ticketCategoryId, 'tickets-category');
  const rows = await getEmbedRegistry(w.guildId);
  const record = rows.find(row => row.messageId === w.target.id);
  assert.ok(record, 'the replacement stays editable in the existing Builder');
  assert.deepEqual(record.snapshot.description, before.description);
  assert.equal(record.components[0].components[0].custom_id, 'create_ticket');
  assert.equal(record.components[0].components[1].label, 'Support assistant');
  assert.equal(record.components[0].components[1].emoji.id, '1800000000000000099');
  assert.equal(record.components[0].components.length, 2);
  const editCount = w.target.edits.length;
  await transfer(w.client, {source: w.old, target: w.target}, {apply: true});
  assert.equal(w.target.edits.length, editCount, 'repeating the operation never duplicates controls');
  assert.equal((await getEmbedRegistry(w.guildId)).filter(row => row.messageId === w.target.id).length, 1);
});

test('a rejected config write restores the previous controls and does not replace embed content', async t => {
  const w = world(t, {rejectConfig: true});
  const before = w.target.embeds[0].toJSON();
  await assert.rejects(transfer(w.client, {source: w.old, target: w.target}, {apply: true}));
  assert.deepEqual(w.target.embeds[0].toJSON(), before);
  assert.deepEqual(w.target.components, []);
  assert.equal(w.values.get(getGuildConfigKey(w.guildId)).ticketPanelMessageId, w.old.id);
});

test('a foreign target or unrelated source is rejected without touching either message', async t => {
  const w = world(t);
  w.target.author = {id: 'another-bot'};
  await assert.rejects(transfer(w.client, {source: w.old, target: w.target}, {apply: true}));
  assert.equal(w.target.edits.length, 0);
  assert.deepEqual(w.writes, []);
  w.target.author = w.client.user;
  w.old.components = [];
  await assert.rejects(transfer(w.client, {source: w.old, target: w.target}, {apply: true}));
  assert.equal(w.target.edits.length, 0);
});
