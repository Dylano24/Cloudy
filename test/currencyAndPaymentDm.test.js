import test from 'node:test';
import assert from 'node:assert/strict';
import currencyCommand from '../src/commands/Economy/currency.js';
import economyCommand from '../src/commands/Economy/economy.js';
import {
  canGrantCurrency, parseCurrencyAmount, grantCurrency, grantCurrencyToMembers,
} from '../src/services/currencyGrantService.js';
import { fillIncomingPaymentTemplate } from '../src/services/incomingPaymentDmService.js';

const guildId = '1532882647838228723';
const ownerId = '1532882647838228724';
const memberId = '1532882647838228725';

test('owner-only slash currency scopes and confirmation are registered', () => {
  const data = currencyCommand.data.toJSON();
  assert.equal(data.name, 'currency');
  assert.deepEqual(data.options.map(option => option.name), ['user', 'me', 'everyone']);
  assert.equal(data.options[2].options.find(option => option.name === 'confirm')?.required, true);
  assert.equal(economyCommand.data.toJSON().name, 'economy');
});

test('currency minting only authorizes bot owners, guild owners or Owner role members', () => {
  const interaction = (role, userId = memberId) => ({
    guildId, guild: { ownerId }, user: { id: userId },
    member: { roles: { cache: { some: fn => role ? fn({ name: role }) : false } } },
  });
  assert.equal(canGrantCurrency(interaction('Owner')), true);
  assert.equal(canGrantCurrency(interaction('oWnEr')), true);
  assert.equal(canGrantCurrency(interaction(null, ownerId)), true);
  assert.equal(canGrantCurrency(interaction('Administrator')), false);
  assert.equal(canGrantCurrency(interaction('Moderator')), false);
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
