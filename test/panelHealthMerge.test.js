import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTicketPanels } from '../src/services/panelHealthService.js';
import { updateGuildConfig, getGuildConfig } from '../src/services/config/guildConfig.js';

test('panel recovery preserves a configuration edit made while Discord fetch was pending', async () => {
  const guildId = '960000000000000001';
  const config = { prefix: '!', ticketPanelChannelId: 'channel', ticketPanelMessageId: 'old', maxTicketsPerUser: 3 };
  const panel = { id: 'recovered', author: { id: 'bot' }, components: [{ type: 1, components: [{ type: 2, custom_id: 'create_ticket' }] }] };
  let client;
  const channel = { messages: { fetch: async query => {
    if (typeof query === 'string') return null;
    await updateGuildConfig(client, guildId, { maxTicketsPerUser: 9 });
    return new Map([['recovered', panel]]);
  } } };
  const guild = { id: guildId, channels: { fetch: async () => channel } };
  client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) }, db: { get: async () => config, set: async () => true } };
  const result = await reconcileTicketPanels(client);
  assert.equal(result.recoveredIds, 1);
  const current = await getGuildConfig(client, guildId);
  assert.equal(current.ticketPanelMessageId, 'recovered');
  assert.equal(current.maxTicketsPerUser, 9);
});
