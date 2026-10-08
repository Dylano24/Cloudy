import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import dashboard from '../src/commands/Economy/modules/economy_dashboard.js';
import { BotConfig } from '../src/config/bot.js';

for (const [action, value, expectedKey] of [
  ['change_currency', '"\\', 'symbol'],
  ['change_name', '$&"coins\\\nnext', 'name'],
]) {
  test(`currency dashboard safely persists literal ${expectedKey} characters to the existing JavaScript configuration`, async t => {
    const source = 'const currency = {\n symbol: "$",\n name: "coin", // Currency display name\n namePlural: "coins", // Plural display name\n};\ncurrency;';
    let written;
    t.mock.method(fs, 'readFile', async () => source);
    t.mock.method(fs, 'writeFile', async (_path, content) => { written = content; });
    let collect;
    const guild = { id: 'currency-test-guild', name: 'Currency Test' };
    const client = { db: { list: async () => [] } };
    await dashboard.execute({
      id: 'currency-dashboard', user: { id: 'manager' }, guild, client,
      createdTimestamp: Date.now(), deferred: true,
      channel: { createMessageComponentCollector: () => ({ on: (event, callback) => { if (event === 'collect') collect = callback; } }) },
      editReply: async () => {}, fetchReply: async () => ({ id: 'dashboard-message' }),
    }, {}, client);
    const submitted = {
      user: { id: 'manager' }, fields: { getTextInputValue: () => value },
      deferReply: async () => {}, editReply: async () => {},
    };
    await collect({
      id: 'currency-select', user: { id: 'manager' }, values: [action],
      showModal: async () => {}, awaitModalSubmit: async () => submitted,
    });
    assert.equal(typeof written, 'string');
    const saved = vm.runInNewContext(written);
    assert.equal(saved[expectedKey], value.trim());
    if (expectedKey === 'name') assert.equal(saved.namePlural, `${value.trim()}s`);
    else assert.equal(saved.name, BotConfig.economy.currency.name);
  });
}
