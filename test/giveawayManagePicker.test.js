import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';
import command from '../src/commands/Giveaway/giveaway.js';
import buttons from '../src/interactions/buttons/giveaway/giveaway.js';
import select from '../src/interactions/selectMenus/giveaway/giveawayManage.js';
import messageDeleted from '../src/events/giveawayOriginalMessageDelete.js';
import bulkDeleted from '../src/events/giveawayOriginalMessageBulkDelete.js';
import channelDeleted from '../src/events/giveawayOriginalChannelDelete.js';
import {
  GIVEAWAY_MANAGE_PAGE_SIZE,
  buildGiveawayManagePicker,
  isActiveManageableGiveaway,
  listManageableGiveaways,
  selectGiveawayToManage,
  showGiveawayManagePicker,
} from '../src/services/giveawayManagePicker.js';
import { cleanupDeletedGiveaways } from '../src/services/giveawayDeletedMessageSync.js';
import { createGiveawayButtons } from '../src/services/giveawayService.js';
import { deleteGiveaway, getGuildGiveaways } from '../src/utils/giveaways.js';

const GUILD = '156000000000000001';
const OWNER = '156000000000000002';
const GIVEAWAY_ID = '156000000000000003';
const CHANNEL = '156000000000000008';
const BOT = 'cloudy';
const json = value => value?.toJSON?.() || value;
const prize = (n, ended = false) => ({
  messageId: String(156000000000000100n + BigInt(n)),
  guildId: GUILD, channelId: CHANNEL,
  prize: 'Giveaway prize ' + n, endsAt: Date.now() + (n + 1) * 60000,
  createdAt: new Date(Date.now() + n * 1000).toISOString(),
  participants: ['a'], ended, isEnded: ended,
});

function world(giveaways = [prize(1)]) {
  const records = new Map(giveaways.map(item => [item.messageId, structuredClone(item)]));
  const posts = new Map(giveaways.map(item =>
    [item.messageId, { id: item.messageId, author: { id: BOT } }]));
  const channel = {
    id: CHANNEL, name: 'giveaways',
    messages: { fetch: async id => posts.get(id) || null },
  };
  const channels = new Collection([[CHANNEL, channel]]);
  const guild = {
    id: GUILD,
    ownerId: OWNER,
    channels: { cache: channels, fetch: async id => channels.get(id) || null },
  };
  const client = {
    user: { id: BOT },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    db: {
      get: async () => Object.fromEntries([...records].map(([id, item]) => [id, structuredClone(item)])),
      set: async (key, value) => {
        records.clear();
        for (const [id, item] of Object.entries(value)) records.set(id, structuredClone(item));
        return true;
      },
    },
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
      deletedReplies: [],
      deleteReply: async () => { result.deletedReplies.push('@original'); },
    };
    return result;
  }
  const deletedMessage = (item, authorId = BOT) => ({
    client, guild, guildId: GUILD, channel, channelId: item.channelId, id: item.messageId,
    author: { id: authorId },
  });
  return { client, guild, channel, channels, records, posts, interaction, deletedMessage };
}

test('/giveaway manage is private and preserves the Owner-only permission gate', () => {
  const data = command.data.toJSON();
  assert.deepEqual(data.options.map(option => option.name), ['create', 'manage']);
  assert.deepEqual(data.options[1].options || [], []);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(GIVEAWAY_MANAGE_PAGE_SIZE, 25);
  assert.equal(select.name, 'gmanage_select');
  assert.ok(buttons.some(button => button.name === 'gmanage_page'));
  assert.equal(createGiveawayButtons(prize(1)).length, 1);
});

test('active and not expired is required, even when ended flag has not caught up', () => {
  const current = prize(1);
  assert.equal(isActiveManageableGiveaway(current), true);
  assert.equal(isActiveManageableGiveaway(prize(2, true)), false);
  assert.equal(isActiveManageableGiveaway({ ...current, endsAt: Date.now() - 1000 }), false);
  assert.equal(isActiveManageableGiveaway({ ...current, endsAt: 0 }), false);
  assert.equal(isActiveManageableGiveaway({ ...current, messageId: 'invalid' }), false);
});

test('only active posted giveaways appear; no ended, expired or deleted entries', async () => {
  const active = prize(1);
  const ended = prize(2, true);
  const expired = { ...prize(3), endsAt: Date.now() - 1000 };
  const removed = prize(4);
  const w = world([ended, active, expired, removed]);
  w.posts.delete(removed.messageId);
  const picker = w.interaction();
  await command.execute(picker);
  assert.equal(picker.deferred.flags, MessageFlags.Ephemeral);
  const menu = json(picker.response.components[0]).components[0];
  assert.deepEqual(menu.options.map(option => option.value), [active.messageId]);
  assert.match(menu.options[0].description, /Active.*#giveaways/);
  assert.ok(picker.response.embeds[0].thumbnail.url);
  assert.equal(w.records.has(removed.messageId), false, 'missing original is pruned');
  assert.equal(w.records.has(ended.messageId), true, 'ended history is not destroyed');
  assert.equal(w.records.has(expired.messageId), true, 'expired history is not destroyed');
  const choose = w.interaction(OWNER, 'select', { values: [active.messageId] });
  await select.execute(choose, w.client, [OWNER]);
  assert.equal(choose.updated, true);
  assert.equal(choose.response.embeds[0].title, 'Manage giveaway');
  const labels = choose.response.components.flatMap(row => json(row).components.map(c => c.label));
  assert.deepEqual(labels, ['Reroll', 'Edit text', 'Edit timer', 'End', 'View participants', 'Delete', 'Edit claim']);
});

test('when there are no active giveaways, the private menu is empty despite ended history', async () => {
  const w = world([prize(1, true), { ...prize(2), endsAt: Date.now() - 1000 }]);
  const picker = w.interaction();
  await showGiveawayManagePicker(picker, w.client);
  assert.equal(picker.response.components.length, 0);
  assert.match(picker.response.embeds[0].description, /no active giveaways/i);
  assert.equal(w.records.size, 2);
});

test('multiple active giveaways are paginated without duplicates', async () => {
  const giveaways = Array.from({ length: 56 }, (_, i) => prize(i));
  const w = world(giveaways);
  const sorted = await listManageableGiveaways(w.client, GUILD);
  const first = buildGiveawayManagePicker(sorted, w.guild, OWNER, 0);
  assert.equal(json(first.components[0]).components[0].options.length, 25);
  assert.equal(json(first.components[1]).components[0].disabled, true);
  const next = w.interaction(OWNER, 'button');
  await buttons.find(item => item.name === 'gmanage_page').execute(next, w.client, [OWNER, '1']);
  assert.equal(next.updated, true);
  assert.equal(json(next.response.components[0]).components[0].options.length, 25);
  const last = buildGiveawayManagePicker(sorted, w.guild, OWNER, 2);
  assert.equal(json(last.components[0]).components[0].options.length, 6);
  assert.equal(json(last.components[1]).components[1].disabled, true);
  const ids = [first, next.response, last].flatMap(payload =>
    json(payload.components[0]).components[0].options.map(option => option.value));
  assert.equal(new Set(ids).size, 56);
});

test('non-owners and a different requester cannot open the picker or select a giveaway', async () => {
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

test('selection from a stale menu refreshes instead of opening ended or deleted giveaway', async () => {
  const current = prize(1);
  const w = world([current]);
  w.posts.delete(current.messageId);
  const stale = w.interaction(OWNER, 'select', { values: [current.messageId] });
  await selectGiveawayToManage(stale, w.client, OWNER);
  assert.equal(stale.response.components.length, 0);
  assert.match(stale.response.embeds[0].description, /no active giveaways/);
  assert.equal(w.records.has(current.messageId), false);
  const expired = world([{ ...current, endsAt: Date.now() - 1000 }]);
  const late = expired.interaction(OWNER, 'select', { values: [current.messageId] });
  await selectGiveawayToManage(late, expired.client, OWNER);
  assert.equal(late.response.components.length, 0);
});

test('Manage Delete removes an original from the database and any open picker', async () => {
  const w = world([prize(1), prize(2)]);
  const first = prize(1);
  assert.equal(await deleteGiveaway(w.client, GUILD, first.messageId), true);
  const picker = w.interaction();
  await showGiveawayManagePicker(picker, w.client);
  const values = json(picker.response.components[0]).components[0].options.map(x => x.value);
  assert.deepEqual(values, [prize(2).messageId]);
  const stale = w.interaction(OWNER, 'select', { values: [first.messageId] });
  await selectGiveawayToManage(stale, w.client, OWNER);
  assert.deepEqual(json(stale.response.components[0]).components[0].options.map(x => x.value), [prize(2).messageId]);
});

test('manual in-channel message deletion removes only that giveaway, not other messages', async () => {
  const one = prize(1);
  const two = prize(2);
  const w = world([one, two]);
  await messageDeleted.execute(w.deletedMessage({ ...one, messageId: '156999999999999999' }));
  assert.equal(w.records.size, 2);
  await messageDeleted.execute(w.deletedMessage(one, 'member')); // not a Cloudy message
  assert.equal(w.records.size, 2);
  w.posts.delete(one.messageId);
  await messageDeleted.execute(w.deletedMessage(one));
  assert.equal(w.records.has(one.messageId), false);
  assert.equal(w.records.has(two.messageId), true);
  const picker = w.interaction();
  await showGiveawayManagePicker(picker, w.client);
  assert.deepEqual(json(picker.response.components[0]).components[0].options.map(x => x.value), [two.messageId]);
});

test('bulk deleting original messages removes matching records only', async () => {
  const [one, two, three] = [prize(1), prize(2), prize(3)];
  const w = world([one, two, three]);
  w.posts.delete(one.messageId);
  w.posts.delete(three.messageId);
  const messages = new Collection([
    [one.messageId, w.deletedMessage(one)],
    [three.messageId, w.deletedMessage(three)],
    ['elsewhere', w.deletedMessage({ ...two, messageId: '156999999999999999' })],
  ]);
  await bulkDeleted.execute(messages);
  assert.deepEqual([...w.records.keys()], [two.messageId]);
});

test('deleting a giveaway channel removes all records from that channel only', async () => {
  const one = prize(1);
  const other = { ...prize(2), channelId: '156000000000000019' };
  const w = world([one, other]);
  await channelDeleted.execute({ id: CHANNEL, guildId: GUILD, guild: w.guild, client: w.client }, w.client);
  assert.deepEqual([...w.records.keys()], [other.messageId]);
});

test('Discord fetch failures do not silently delete valid giveaway records', async () => {
  const current = prize(1);
  const w = world([current]);
  w.channel.messages.fetch = async () => {
    const error = new Error('Discord temporarily unavailable');
    error.code = 50013;
    throw error;
  };
  const picker = w.interaction();
  await showGiveawayManagePicker(picker, w.client);
  assert.match(JSON.stringify(picker.response), /could not be loaded/i);
  assert.equal(w.records.has(current.messageId), true);
});

test('the registry cleanup respects the original channel and is idempotent', async () => {
  const current = prize(1);
  const w = world([current]);
  const wrong = await cleanupDeletedGiveaways(w.client, GUILD, {
    entries: [{ channelId: 'wrong-channel', messageId: current.messageId }],
  });
  assert.equal(wrong, 0);
  assert.equal(w.records.size, 1);
  const correct = await cleanupDeletedGiveaways(w.client, GUILD, {
    entries: [{ channelId: CHANNEL, messageId: current.messageId }],
  });
  assert.equal(correct, 1);
  assert.equal(w.records.size, 0);
  assert.equal(await cleanupDeletedGiveaways(w.client, GUILD, {
    entries: [{ channelId: CHANNEL, messageId: current.messageId }],
  }), 0);
  assert.deepEqual(await getGuildGiveaways(w.client, GUILD), []);
});

test('short private giveaway Manage notices disappear after exactly 10 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = () => new Promise(resolve => setImmediate(resolve));

  // The empty-state message shown in the screenshot is transient.
  const empty = world([prize(1, true)]);
  const noActive = empty.interaction();
  await showGiveawayManagePicker(noActive, empty.client);
  assert.match(noActive.response.embeds[0].description, /no active giveaways/);
  t.mock.timers.tick(9_999);
  await settle();
  assert.deepEqual(noActive.deletedReplies, []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(noActive.deletedReplies, ['@original']);

  // Owner restriction, invalid selection and data loading errors are notices.
  const unauthorized = empty.interaction('not-an-owner');
  await command.execute(unauthorized);
  const invalid = empty.interaction(OWNER, 'select', { values: ['invalid-id'] });
  await selectGiveawayToManage(invalid, empty.client, OWNER);
  const broken = world([]);
  broken.client.db.get = async () => { throw new Error('Storage is temporarily unavailable'); };
  const error = broken.interaction();
  await showGiveawayManagePicker(error, broken.client);
  for (const interaction of [unauthorized, invalid, error]) {
    assert.deepEqual(interaction.deletedReplies, []);
  }
  t.mock.timers.tick(10_000);
  await settle();
  for (const interaction of [unauthorized, invalid, error]) {
    assert.deepEqual(interaction.deletedReplies, ['@original']);
  }

  // A stale menu that becomes empty is also a short notice.
  const staleWorld = world([prize(2)]);
  staleWorld.posts.clear();
  const stale = staleWorld.interaction(OWNER, 'select', { values: [prize(2).messageId] });
  await selectGiveawayToManage(stale, staleWorld.client, OWNER);
  assert.equal(stale.response.components.length, 0);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(stale.deletedReplies, ['@original']);
});

test('active giveaway picker and interactive Manage controls never use the 10-second notice timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world([prize(1)]);
  const picker = w.interaction();
  await showGiveawayManagePicker(picker, w.client);
  assert.ok(picker.response.components.length > 0);
  const choice = w.interaction(OWNER, 'select', { values: [prize(1).messageId] });
  await selectGiveawayToManage(choice, w.client, OWNER);
  assert.ok(choice.response.components.length > 0);
  t.mock.timers.tick(11_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(picker.deletedReplies, []);
  assert.deepEqual(choice.deletedReplies, []);
});
