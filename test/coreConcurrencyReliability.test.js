import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/utils/memoryStorage.js';
import { ResponseCoordinator } from '../src/utils/responseCoordinator.js';

test('concurrent memory increments do not lose counter updates', async () => {
  const storage = new MemoryStorage();
  const results = await Promise.all(Array.from({ length: 40 }, () => storage.increment('counter')));
  assert.equal(await storage.get('counter'), 40);
  assert.equal(new Set(results).size, 40);
});

test('concurrent memory decrements do not lose counter updates', async () => {
  const storage = new MemoryStorage();
  await storage.set('counter', 40);
  await Promise.all(Array.from({ length: 40 }, () => storage.decrement('counter')));
  assert.equal(await storage.get('counter'), 0);
});

test('memory counter updates ignore expired values and retain persistent replacement semantics', async t => {
  t.mock.method(Date, 'now', () => 1000);
  const storage = new MemoryStorage();
  await storage.set('counter', 50, 1);
  Date.now.mock.mockImplementation(() => 2001);
  assert.equal(await storage.increment('counter', 3), 3);
  Date.now.mock.mockImplementation(() => 10000);
  assert.equal(await storage.get('counter'), 3);
});

function discordInteraction() {
  const output = [];
  const interaction = {
    replied: false,
    deferred: false,
    async reply(payload) {
      if (this.replied || this.deferred) throw new Error('Interaction already acknowledged');
      await Promise.resolve();
      output.push(['reply', payload]);
      this.replied = true;
    },
    async followUp(payload) {
      if (!this.replied && !this.deferred) throw new Error('Interaction has not been acknowledged');
      output.push(['followUp', payload]);
    },
    async editReply(payload) {
      if (!this.replied && !this.deferred) throw new Error('Interaction has not been acknowledged');
      output.push(['editReply', payload]);
      this.replied = true;
    },
  };
  return { interaction, output };
}

test('response coordinator acknowledges the first Discord response before followups', async () => {
  const { interaction, output } = discordInteraction();
  const coordinator = ResponseCoordinator.attach(interaction);
  await coordinator.respond({ content: 'first' });
  await coordinator.respond({ content: 'second' });
  assert.deepEqual(output, [
    ['reply', { content: 'first' }],
    ['followUp', { content: 'second' }],
  ]);
});

test('a failed initial Discord reply leaves the interaction available for recovery', async () => {
  const { interaction, output } = discordInteraction();
  const originalReply = interaction.reply;
  interaction.reply = async () => { throw new Error('temporary REST failure'); };
  const coordinator = ResponseCoordinator.attach(interaction);
  await assert.rejects(coordinator.respond({ content: 'first' }), /temporary REST failure/);
  assert.equal(interaction.replied, false);
  interaction.reply = originalReply;
  await coordinator.respond({ content: 'retry' });
  assert.deepEqual(output, [['reply', { content: 'retry' }]]);
});

test('concurrent prefix responses reuse the first message instead of sending duplicates', async () => {
  const output = [];
  const sent = { async edit(payload) { output.push(['edit', payload]); return this; } };
  const interaction = { replied: false, deferred: false, _isPrefixCommand: true };
  const message = { channel: { async send(payload) {
    await Promise.resolve();
    output.push(['send', payload]);
    return sent;
  } } };
  const coordinator = ResponseCoordinator.attach(interaction, { message });
  await Promise.all([
    coordinator.respond({ content: 'first' }),
    coordinator.respond({ content: 'second' }),
  ]);
  assert.deepEqual(output, [
    ['send', { content: 'first' }],
    ['edit', { content: 'second' }],
  ]);
});
