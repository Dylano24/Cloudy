import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { matchesConfiguredTicketPanel } from '../src/handlers/ticketButtons.js';

const config = {
  ticketPanelChannelId: '100000000000000001',
  ticketPanelMessageId: '100000000000000002',
  ticketSystemDisabled: false,
};

test('ticket creation accepts only the exact configured support panel', () => {
  assert.equal(matchesConfiguredTicketPanel({
    guildId: 'guild',
    channelId: '100000000000000001',
    message: { id: '100000000000000002' },
  }, config), true);

  assert.equal(matchesConfiguredTicketPanel({
    guildId: 'guild',
    channelId: 'faq-channel',
    message: { id: 'faq-message' },
  }, config), false);

  assert.equal(matchesConfiguredTicketPanel({
    guildId: 'guild',
    channelId: '100000000000000001',
    message: { id: 'wrong-message' },
  }, config), false);
});

test('ticket creation fails closed while the ticket system is disabled or panel identity is missing', () => {
  assert.equal(matchesConfiguredTicketPanel({
    guildId: 'guild',
    channelId: config.ticketPanelChannelId,
    message: { id: config.ticketPanelMessageId },
  }, { ...config, ticketSystemDisabled: true }), false);

  assert.equal(matchesConfiguredTicketPanel({
    guildId: 'guild',
    channelId: config.ticketPanelChannelId,
    message: null,
  }, config), false);
});

test('create_ticket handler validates official panel before rate limiting or opening a modal', () => {
  const source = fs.readFileSync('src/handlers/ticketButtons.js', 'utf8');
  const start = source.indexOf("name: 'create_ticket'");
  const end = source.indexOf("const createTicketModalHandler", start);
  const body = source.slice(start, end);

  const configCheck = body.indexOf('getGuildConfig');
  const originCheck = body.indexOf('matchesConfiguredTicketPanel');
  const rateLimit = body.indexOf('checkRateLimit');
  const modal = body.indexOf('showModal');

  assert.ok(configCheck >= 0);
  assert.ok(originCheck > configCheck);
  assert.ok(rateLimit > originCheck);
  assert.ok(modal > rateLimit);
});
