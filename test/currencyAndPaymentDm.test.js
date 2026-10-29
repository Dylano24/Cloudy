import test from 'node:test';
import assert from 'node:assert/strict';
import currencyCommand from '../src/commands/Economy/currency.js';
import economyCommand from '../src/commands/Economy/economy.js';
import {
  canGrantCurrency, parseCurrencyAmount, grantCurrency, grantCurrencyToMembers,
} from '../src/services/currencyGrantService.js';
import { fillIncomingPaymentTemplate } from '../src/services/incomingPaymentDmService.js';
import { getResponseLifetime } from '../src/utils/responseLifetime.js';
import { TRANSIENT_MESSAGE_MS, deleteLifecycleMessage } from '../src/utils/interactionMessageLifecycle.js';
import { isPersistentBotMessage } from '../src/utils/transientResponse.js';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';

const guildId = '1532882647838228723';
const ownerId = '1532882647838228724';
const memberId = '1532882647838228725';

test('staff money scopes replace currency and the obsolete economy give command', () => {
  const data = currencyCommand.data.toJSON();
  assert.equal(data.name, 'give');
  assert.match(data.description, /^Staff only:/);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ModerateMembers));
  assert.equal(data.options[0].name, 'money');
  assert.deepEqual(data.options[0].options.map(option => option.name), ['user', 'me', 'everyone']);
  assert.deepEqual(data.options[0].options[2].options.map(option => option.name), ['amount']);
  assert.deepEqual(data.options[0].options.map(option => option.options.at(-1).description),
    ['Amount of money to give to this user', 'Amount of money to give to myself', 'Amount of money to give to each user']);
  // /give money never says "cash".
  assert.doesNotMatch(JSON.stringify(data), /cash/i);
  assert.deepEqual(economyCommand.data.toJSON().options.map(option => option.name), ['dashboard']);
});

test('/give money authorizes bot owners, the server owner and Cloudy staff only', () => {
  const interaction = (role, userId = memberId, permissions = false) => ({
    guildId, guild: { ownerId }, user: { id: userId },
    member: {
      id: userId,
      roles: { cache: new Collection(role ? [['role-id', { id: 'role-id', name: role }]] : []) },
      permissions: { has: () => permissions },
    },
  });
  assert.equal(canGrantCurrency(interaction('Owner')), true);
  assert.equal(canGrantCurrency(interaction('oWnEr')), true);
  assert.equal(canGrantCurrency(interaction(null, ownerId)), true);
  assert.equal(canGrantCurrency(interaction('Staff')), true);
  assert.equal(canGrantCurrency(interaction('Administrator')), true);
  assert.equal(canGrantCurrency(interaction('Moderator')), true);
  assert.equal(canGrantCurrency(interaction('Member', memberId, true)), true);
  assert.equal(canGrantCurrency(interaction('Member'), { modRole: 'role-id' }), true);
  assert.equal(canGrantCurrency(interaction('Member')), false);
  assert.equal(canGrantCurrency(interaction(null)), false);
  assert.equal(canGrantCurrency({ ...interaction('Owner'), guildId: null }), false);
});

test('mint amounts reject invalid and unsafe inputs', () => {
  assert.equal(parseCurrencyAmount('250000'), 250000);
  for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992', null]) {
    assert.throws(() => parseCurrencyAmount(value));
  }
});

test('atomic mint adds to target only, without touching the owner balance', async () => {
  const accounts = new Map([[ownerId, { wallet: 500 }], [memberId, { wallet: 25 }]]);
  const writes = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: async (g, id, initial, mutator) => {
      assert.equal(g, guildId);
      const account = { ...(accounts.get(id) || initial) };
      mutator(account);
      accounts.set(id, account);
      writes.push(id);
      return { account };
    },
  } };
  const result = await grantCurrency(client, guildId, memberId, 50);
  assert.equal(result, 75);
  assert.equal(accounts.get(memberId).wallet, 75);
  assert.equal(accounts.get(ownerId).wallet, 500);
  assert.deepEqual(writes, [memberId]);
});

test('server-wide grants pay each unique member once and report failures', async () => {
  const accounts = new Map([[ownerId, { wallet: 200 }], [memberId, { wallet: 10 }]]);
  const client = { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: async (g, id, initial, mutate) => {
      if (id === '1532882647838228726') throw new Error('Storage unavailable');
      const account = { ...(accounts.get(id) || initial) };
      mutate(account);
      accounts.set(id, account);
      return { account };
    },
  } };
  const result = await grantCurrencyToMembers(client, guildId,
    [ownerId, memberId, memberId, '1532882647838228726'], 20);
  assert.equal(result.total, 3);
  assert.equal(result.granted, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(accounts.get(ownerId).wallet, 220);
  assert.equal(accounts.get(memberId).wallet, 30);
});

test('incoming payment DM uses saved layout and injects real sender, payment and cash', () => {
  const saved = {
    title: 'Incoming payment',
    description: '{dynamic} paid you **{dynamic}**.',
    fields: [{ name: 'Your new cash', value: '{dynamic}', inline: false }],
    color: 0xFFFFFF,
    thumbnail: { url: 'https://example.com/cloudy.png' },
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
  const result = fillIncomingPaymentTemplate(saved, {
    senderName: 'feelfate', amount: 10, newCash: 12345,
  });
  assert.equal(result.title, 'Incoming payment');
  assert.equal(result.description, 'feelfate paid you **$10**.');
  assert.equal(result.fields[0].name, 'Your new cash');
  assert.equal(result.fields[0].value, '$12,345');
  assert.equal(result.thumbnail.url, saved.thumbnail.url);
  assert.equal(result.footer.text, saved.footer.text);
  assert.doesNotMatch(JSON.stringify(result), /\\{dynamic\\}/i);
});

test('incoming payment DM never sends placeholder text or a stale cash balance', () => {
  const result = fillIncomingPaymentTemplate({
    title: 'Incoming payment', description: '{dynamic} paid you {dynamic}.',
    fields: [{ name: 'Your new cash', value: '$1,000' }],
  }, { senderName: 'new_sender', amount: 25, newCash: 3000 });
  assert.equal(result.description, 'new\\_sender paid you $25.');
  assert.equal(result.fields[0].value, '$3,000');
});

function currencyInteraction(channelId, scope = 'me') {
  const gamblingChannel = {
    id: '1533188412507558130', name: '🎲｜gambling',
    isTextBased: () => true, isSendable: () => true,
  };
  const shopChannel = {
    id: '1533188412507558131', name: 'shop',
    isTextBased: () => true, isSendable: () => true,
  };
  const replies = [];
  const interaction = {
    id: '1532882647838228730', guildId,
    guild: {
      id: guildId, ownerId,
      channels: { cache: { find: fn => [gamblingChannel, shopChannel].find(fn) } },
    },
    channelId, user: { id: ownerId, username: 'owner', bot: false },
    options: {
      getSubcommand: () => scope, getInteger: () => 25,
      getBoolean: () => true,
    },
    replied: false, deferred: false, deferFlags: null,
    async deferReply(options) { this.deferred = true; this.deferFlags = options?.flags ?? null; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
  };
  return { interaction, replies };
}

function grantingClient(changes) {
  return { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: async (guild, user, initial, change) => {
      const account = { ...initial, wallet: 100 };
      change(account);
      changes.push({ guild, user, wallet: account.wallet });
      return { account };
    },
  } };
}

test('staff can give money in every channel with a private ten-second reply', async () => {
  for (const channelId of ['1533188412507558131', '1533188412507558132']) {
    const { interaction, replies } = currencyInteraction(channelId);
    const changes = [];
    await currencyCommand.execute(interaction, {}, grantingClient(changes));
    assert.equal(interaction.deferFlags, MessageFlags.Ephemeral);
    assert.equal(getResponseLifetime(interaction), TRANSIENT_MESSAGE_MS);
    assert.deepEqual(changes, [{ guild: guildId, user: ownerId, wallet: 125 }]);
    assert.equal(replies.length, 1);
    assert.match(JSON.stringify(replies[0]), /Money added/);
    assert.doesNotMatch(JSON.stringify(replies[0]), /Wrong channel/);
  }
});

test('currency still grants to owner in gambling with the same ten-second reply lifetime', async () => {
  const { interaction, replies } = currencyInteraction('1533188412507558130');
  const changes = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: async (guild, user, initial, change) => {
      const account = { ...initial, wallet: 100 };
      change(account);
      changes.push({ guild, user, wallet: account.wallet });
      return { account };
    },
  } };
  await currencyCommand.execute(interaction, {}, client);
  assert.equal(getResponseLifetime(interaction), TRANSIENT_MESSAGE_MS);
  assert.deepEqual(changes, [{ guild: guildId, user: ownerId, wallet: 125 }]);
  assert.equal(replies.length, 1);
  assert.match(JSON.stringify(replies[0]), /Money added/);
  assert.match(JSON.stringify(replies[0]), /New money balance/);
  assert.doesNotMatch(JSON.stringify(replies[0]), /balance was not deducted|cash/i);
});

test('currency ephemeral reply deletes after its lifecycle even inside staff message logs', async () => {
  const deleted = [];
  const message = {
    id: '1532882647838228709',
    channel: { name: 'staff-message-logs' },
    flags: { has: flag => flag === MessageFlags.Ephemeral },
  };
  assert.equal(isPersistentBotMessage(message), true);
  const interaction = {
    commandName: 'give',
    ephemeral: true,
    webhook: { deleteMessage: async id => { deleted.push(id); } },
  };
  assert.equal(await deleteLifecycleMessage(message, interaction), true);
  assert.deepEqual(deleted, [message.id]);
});

test('ordinary staff logs stay permanent even if a generic timer tries to delete', async () => {
  const deleted = [];
  const message = {
    id: '1532882647838228710',
    channel: { name: 'staff-message-logs' },
    delete: async () => { deleted.push('message'); },
  };
  const interaction = {
    commandName: 'give',
    webhook: { deleteMessage: async () => { deleted.push('webhook'); } },
  };
  assert.equal(await deleteLifecycleMessage(message, interaction), false);
  assert.deepEqual(deleted, []);
});

test('a member who is not staff gets a private Permission denied and no money is added', async () => {
  const { interaction, replies } = currencyInteraction('1533188412507558132');
  interaction.user = { id: memberId, username: 'member', bot: false };
  interaction.member = { id: memberId, roles: { cache: new Collection() }, permissions: { has: () => false } };
  const changes = [];
  await currencyCommand.execute(interaction, {}, grantingClient(changes));
  assert.deepEqual(changes, []);
  assert.equal(interaction.deferFlags, MessageFlags.Ephemeral);
  assert.equal(getResponseLifetime(interaction), TRANSIENT_MESSAGE_MS);
  assert.equal(replies.length, 1);
  const data = replies[0].embeds[0].toJSON();
  assert.equal(data.title, 'Permission denied');
  assert.equal(data.description, 'Only Cloudy staff can give money.');
});

test('everyone grant needs only an amount and pays every current human member once', async () => {
  const { interaction, replies } = currencyInteraction('1533188412507558130', 'everyone');
  delete interaction.options.getBoolean;
  interaction.guild.memberCount = 3;
  interaction.guild.members = { fetch: async () => new Map([
    [ownerId, { id: ownerId, user: { bot: false } }],
    [memberId, { id: memberId, user: { bot: false } }],
    ['bot', { id: 'bot', user: { bot: true } }],
  ]) };
  const accounts = new Map([[ownerId, { wallet: 100 }], [memberId, { wallet: 10 }]]);
  const client = { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: async (guild, id, initial, change) => {
      assert.equal(guild, guildId);
      const account = { ...(accounts.get(id) || initial) };
      change(account);
      accounts.set(id, account);
      return { account };
    },
  } };
  await currencyCommand.execute(interaction, {}, client);
  assert.equal(accounts.get(ownerId).wallet, 125);
  assert.equal(accounts.get(memberId).wallet, 35);
  assert.equal(accounts.has('bot'), false);
  assert.equal(getResponseLifetime(interaction), TRANSIENT_MESSAGE_MS);
  const embed = replies[0].embeds[0].toJSON();
  assert.equal(embed.title, 'Money added');
  assert.doesNotMatch(embed.description, /balance was not deducted|confirm/i);
});
