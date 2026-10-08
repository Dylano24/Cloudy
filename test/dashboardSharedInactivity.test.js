import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startDashboardSession } from '../src/utils/dashboardSession.js';

class IdleCollector extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.resetTimer();
  }
  resetTimer({ idle = this.options.idle } = {}) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop('idle'), idle);
  }
  stop(reason = 'user') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.emit('end', [], reason);
  }
  collect(interaction) {
    if (this.ended || !this.options.filter(interaction)) return;
    this.resetTimer();
    this.emit('collect', interaction);
  }
}

test('activity on dashboard buttons keeps the entire dashboard alive for another five minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const collectors = [];
  let deleted = 0;
  const interaction = {
    id: 'dashboard', user: { id: 'owner' }, replied: true,
    editReply: async () => {}, fetchReply: async () => ({ id: 'reply' }),
    deleteReply: async () => { deleted++; },
    channel: { createMessageComponentCollector: options => {
      const collector = new IdleCollector(options);
      collectors.push(collector);
      return collector;
    } },
  };
  await startDashboardSession({ interaction, embeds: [], components: [], selectMenuId: 'select', buttonMatcher: 'button', onSelect: async () => {}, onButton: async () => {} });
  t.mock.timers.tick(270_000);
  collectors[1].collect({ user: { id: 'owner' }, message: { id: 'reply' }, customId: 'button' });
  t.mock.timers.tick(90_000);
  await Promise.resolve();
  assert.equal(deleted, 0);
  assert.ok(collectors.every(collector => !collector.ended));
  t.mock.timers.tick(210_000);
  await Promise.resolve();
  assert.equal(deleted, 1);
  assert.ok(collectors.every(collector => collector.ended));
});
