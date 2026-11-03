import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';
import command from '../src/commands/Giveaway/giveaway.js';
import buttons from '../src/interactions/buttons/giveaway/giveaway.js';
import select from '../src/interactions/selectMenus/giveaway/giveawayManage.js';
import {
  GIVEAWAY_MANAGE_PAGE_SIZE,
  buildGiveawayManagePicker,
  listManageableGiveaways,
  selectGiveawayToManage,
  showGiveawayManagePicker,
} from '../src/services/giveawayManagePicker.js';
import { createGiveawayButtons } from '../src/services/giveawayService.js';

const GUILD = '156000000000000001';
const OWNER = '156000000000000002';
const GIVEAWAY_ID = '156000000000000003';
const json = value => value?.toJSON?.() || value;
const prize = (n, ended = false) => ({
  messageId: String(156000000000000100n + BigInt(n)), guildId: GUILD, channelId: '156000000000000008',
  prize: 'Giveaway prize ' + n, endsAt: Date.now() + (n + 1) * 60000,
  createdAt: new Date(Date.now() + n * 1000).toISOString(),
  participants: ['a'], ended, isEnded: ended,
});

function world(giveaways = [prize(1)]) {
  const guild = {
    id: GUILD,
    ownerId: OWNER,
    channels: { cache: new Collection([['156000000000000008', { id: '156000000000000008', name: 'giveaways' }]]) },
  };
  const client = {
    guilds: { cache: new Collection([[GUILD, guild]]) },
    db: { get: async () => Object.fromEntries(giveaways.map(g => [g.messageId, g])) },
  };
  function interaction(userId = OWNER, type = 'command', opts = {}) {
    const result = {
      client, guild, guildId: GUILD, user: { id: userId },
      member: { id: userId, roles: { cache: new Collection() } },
      inGuild: () => true,
      isButton: () => type === 'button',
      isStringSelectMenu: () => type === 'select',
      options: { getSubcommand: () => 'manage' },
      values: [giveaways[0]?.messageId], ...opts,
      deferReply: async payload => { result.deferred = payload; },
      deferUpdate: async () => { result.updated = true; },
      editReply: async payload => { result.response = payload; },
      reply: async payload => { result.response = payload; },
    };
    return result;
  }
  return { client, guild, interaction };
}

test('/giveaway manage has no required message ID and is hidden from ordinary members', () => {
  const data = command.data.toJSON();
  assert.deepEqual(data.options.map(option => option.name), ['create', 'manage']);
  assert.deepEqual(data.options[1].options || [], []);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(GIVEAWAY_MANAGE_PAGE_SIZE, 25);
  assert.equal(select.name, 'gmanage_select');
  assert.ok(buttons.some(button => button.name === 'gmanage_page'));
  assert.equal(createGiveawayButtons(prize(1)).length, 1);
});

test('Owner receives a private list of multiple active and ended giveaways and can open the selected panel', async () => {
  const active = prize(1);
  const ended = prize(2, true);
  const w = world([ended, active]);
  const picker = w.interaction();
  await command.execute(picker);
  assert.equal(picker.deferred.flags, MessageFlags.Ephemeral);
  const menu = json(picker.response.components[0]).components[0];
  assert.equal(menu.options.length, 2);
  assert.deepEqual(menu.options.map(option => option.value), [active.messageId, ended.messageId]);
  assert.match(menu.options[0].description, /Active.*#giveaways/);
  assert.match(menu.options[1].description, /Ended.*#giveaways/);
  assert.ok(picker.response.embeds[0].thumbnail.url);
  const choose = w.interaction(OWNER, 'select', { values: [ended.messageId] });
  await select.execute(choose, w.client, [OWNER]);
  assert.equal(choose.updated, true);
  assert.equal(choose.response.embeds[0].title, 'Manage giveaway');
  const labels = choose.response.components.flatMap(row => json(row).components.map(c => c.label));
  assert.deepEqual(labels, ['Reroll', 'View participants', 'Delete']);
});

test('Owner can browse over 25 giveaways with Previous and Next; pages never duplicate IDs', async () => {
  const giveaways = Array.from({ length: 56 }, (_, i) => prize(i));
  const w = world(giveaways);
  const sorted = await listManageableGiveaways(w.client, GUILD);
  const first = buildGiveawayManagePicker(sorted, w.guild, OWNER, 0);
  assert.equal(json(first.components[0]).components[0].options.length, 25);
  assert.equal(json(first.components[1]).components[0].disabled, true);
  const next = w.interaction(OWNER, 'button');
  const handler = buttons.find(item => item.name === 'gmanage_page');
  await handler.execute(next, w.client, [OWNER, '1']);
  assert.equal(next.updated, true);
  assert.equal(json(next.response.components[0]).components[0].options.length, 25);
  assert.equal(json(next.response.components[1]).components[0].disabled, false);
  const last = buildGiveawayManagePicker(sorted, w.guild, OWNER, 2);
  assert.equal(json(last.components[0]).components[0].options.length, 6);
  assert.equal(json(last.components[1]).components[1].disabled, true);
  const ids = [first, next.response, last].flatMap(payload =>
    json(payload.components[0]).components[0].options.map(option => option.value));
  assert.equal(new Set(ids).size, 56);
});

test('non-owners and a different requester cannot see or control another giveaway picker', async () => {
  const w = world();
  const outsider = w.interaction('someone-else');
  await command.execute(outsider);
  assert.match(JSON.stringify(outsider.response), /Owner role/);
  assert.equal(outsider.deferred, undefined);
  const unauthorizedSelect = w.interaction('someone-else', 'select');
  await select.execute(unauthorizedSelect, w.client, [OWNER]);
  assert.match(JSON.stringify(unauthorizedSelect.response), /Owner role/);
  const mismatchedOwner = w.interaction(OWNER, 'button');
  await buttons.find(item => item.name === 'gmanage_page').execute(mismatchedOwner, w.client,
    ['different-user', '1']);
  assert.match(JSON.stringify(mismatchedOwner.response), /Owner role/);
});

test('picker gracefully handles no giveaways and a deleted selection', async () => {
  const w = world([]);
  const initial = w.interaction();
  await showGiveawayManagePicker(initial, w.client);
  assert.equal(initial.response.components.length, 0);
  assert.match(initial.response.embeds[0].description, /no giveaways/i);
  const missing = w.interaction(OWNER, 'select', { values: [GIVEAWAY_ID] });
  await selectGiveawayToManage(missing, w.client, OWNER);
  assert.equal(missing.response.components.length, 0);
  assert.match(missing.response.embeds[0].description, /no giveaways/i);
});
