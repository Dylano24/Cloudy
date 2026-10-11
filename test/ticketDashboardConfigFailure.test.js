import test from 'node:test';
import assert from 'node:assert/strict';
import handlers from '../src/interactions/buttons/ticket/ticketDashboard.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

for (const name of ['ticket_dashboard_open', 'ticket_dashboard_max']) {
  test(`${name} answers config failure without rendering default settings`, async t => {
    const replies = [];
    t.mock.method(InteractionHelper, 'safeReply', async (_interaction, payload) => { replies.push(payload); });
    const guildId = name === 'ticket_dashboard_open' ? '980000000000000001' : '980000000000000002';
    const interaction = { guildId, guild: { id: guildId }, inGuild: () => true, memberPermissions: { has: () => true }, update: async () => assert.fail('must not draw default dashboard') };
    await handlers.find(handler => handler.name === name).execute(interaction, { db: { get: async () => { throw new Error('offline'); } } }, [guildId, 'max_tickets']);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, 'Could not open that ticket setting. Please try again.');
    assert.equal(replies[0].embeds, undefined);
  });
}
