import test from 'node:test';
import assert from 'node:assert/strict';
import handlers from '../src/interactions/buttons/ticket/ticketDashboard.js';
import { getGuildConfig } from '../src/services/config/guildConfig.js';

for (const disabled of [true, false]) {
  test(`failed panel removal restores the previous disabled=${disabled} value`, async () => {
    const guildId = disabled ? '985000000000000001' : '985000000000000002';
    let stored = { ticketSystemDisabled: disabled, ticketPanelChannelId: 'channel', ticketPanelMessageId: 'panel' };
    const channel = { isTextBased: () => true, messages: { fetch: async () => ({ id: 'panel', delete: async () => { throw new Error('Discord denied delete'); } }) } };
    const client = { db: { get: async () => stored, set: async (_key, value) => { stored = structuredClone(value); return true; } } };
    const interaction = { guildId, guild: { id: guildId, channels: { cache: new Map([['channel', channel]]), fetch: async () => channel } }, inGuild: () => true,
      memberPermissions: { has: () => true }, deferUpdate: async () => { interaction.deferred = true; }, editReply: async () => {} };
    await handlers.find(handler => handler.name === 'ticket_dashboard_delete').execute(interaction, client, [guildId]);
    assert.equal((await getGuildConfig(client, guildId)).ticketSystemDisabled, disabled);
  });
}
