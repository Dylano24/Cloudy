import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../src/events/interactionCreate.js';

function interaction(guildId, commandName = 'ping') {
  return { guildId, guild: { id: guildId }, user: { id: '950000000000000009', tag: 'Member' }, commandName,
    isChatInputCommand: () => true, isMessageContextMenuCommand: () => false,
    options: { data: [], getSubcommand: () => null, getSubcommandGroup: () => null },
    reply: async () => {}, followUp: async () => {}, editReply: async () => {}, deferReply: async () => {},
  };
}

test('disabled command does not consume the default cooldown', async () => {
  const guildId = '950000000000000001';
  const client = { commands: new Map([['ping', { category: 'utility', execute: async () => assert.fail('disabled command ran') }]]), cooldowns: new Map(), db: { get: async () => ({ disabledCommands: { ping: true } }) } };
  await router.execute(interaction(guildId), client);
  assert.equal(client.cooldowns.has('950000000000000009:ping'), false);
});

test('fast path dashboard is ignored by the router before cooldown and error handling', async () => {
  const value = interaction('950000000000000002', 'ticket');
  value.__ticketDashboardFastPathHandled = true;
  value.reply = async () => assert.fail('router produced another reply');
  const client = { commands: new Map([['ticket', { category: 'ticket', execute: async () => assert.fail('dashboard ran twice') }]]), cooldowns: new Map(), db: { get: async () => assert.fail('router read config') } };
  await router.execute(value, client);
  assert.equal(client.cooldowns.size, 0);
});
