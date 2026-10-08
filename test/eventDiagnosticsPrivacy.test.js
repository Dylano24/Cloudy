import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { logger } from '../src/utils/logger.js';

// Import command configuration offline with a placeholder; no client logs in.
process.env.DISCORD_TOKEN ||= 'offline-test-token';
const { default: messageCreate } = await import('../src/events/messageCreate.js');

function fixture(content, bot = true) {
  const db = { get: async (_key, fallback) => fallback || {}, set: async () => true };
  const client = { user: { id: 'cloudy-bot' }, db, commands: new Collection() };
  const guild = { id: 'audit-diagnostic-guild', channels: { cache: new Collection() } };
  return {
    id: 'private-message-id', content, client, guild,
    author: { id: 'sender', tag: 'Sender', bot }, member: {},
    channel: { id: 'private-channel-id', name: 'private-staff', send: async () => {} },
  };
}

test('message diagnostics preserve identifiers while excluding private message bodies', async t => {
  const logged = [];
  t.mock.method(logger, 'debug', (...args) => logged.push(args));
  const message = fixture('Private discussion: employment details for the new staff member');
  await messageCreate.execute(message, message.client);
  assert.equal(JSON.stringify(logged).includes(message.content), false);
  assert.equal(JSON.stringify(logged).includes(message.id), true);
  assert.equal(JSON.stringify(logged).includes(message.channel.id), true);
});

test('prefix diagnostics retain command names without persisting command arguments', async t => {
  const logged = [];
  for (const level of ['debug', 'info', 'warn', 'error']) {
    t.mock.method(logger, level, (...args) => logged.push(args));
  }
  const message = fixture('!unknowncommand privateStaffNotes-12345', false);
  await messageCreate.execute(message, message.client);
  assert.equal(JSON.stringify(logged).includes('privateStaffNotes-12345'), false);
  assert.equal(JSON.stringify(logged).includes('unknowncommand'), true);
});
