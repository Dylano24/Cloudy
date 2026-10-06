import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { handleInteractionError } from '../src/utils/errorHandler.js';

test('generic unknown errors always keep the Something went wrong title', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sent = null;
  const interaction = {
    id: 'error-isolation',
    createdTimestamp: Date.now(),
    replied: false,
    deferred: false,
    guildId: 'guild',
    channelId: 'channel',
    user: { id: 'user' },
    reply: async payload => { sent = payload; interaction.replied = true; },
    fetchReply: async () => null,
    deleteReply: async () => {},
  };

  await handleInteractionError(interaction, new Error('boom'), { type: 'button' });
  assert.ok(sent?.embeds?.[0]);
  const embed = sent.embeds[0].toJSON?.() || sent.embeds[0];
  assert.equal(embed.title, 'Something went wrong');
  assert.match(embed.description, /Something went wrong/);
  assert.match(embed.description, /Ref:/);
});

test('Ticket limit reached is isolated to the ticket creation modal', () => {
  const source = fs.readFileSync('src/interactions/modals/ticket/createTicketUi.js', 'utf8');
  const errorSource = fs.readFileSync('src/utils/errorHandler.js', 'utf8');

  assert.match(source, /error\.code === 'TICKET_LIMIT_REACHED'/);
  assert.match(source, /title: 'Ticket limit reached'/);
  assert.match(source, /color: '#ED4245'/);
  assert.match(errorSource, /embed\.setTitle\('Something went wrong'\)/);
  assert.doesNotMatch(errorSource, /embed\.setTitle\('Ticket limit reached'\)/);
});
