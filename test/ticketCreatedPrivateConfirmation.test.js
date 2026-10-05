import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('ticket created confirmation stays private and deletes after 10 seconds', () => {
  const source = fs.readFileSync('src/interactions/modals/ticket/createTicketUi.js', 'utf8');
  const start = source.indexOf("const createTicketModal =");
  const end = source.indexOf("const closeTicketModal =", start);
  assert.ok(start >= 0 && end > start);
  const createFlow = source.slice(start, end);

  assert.match(
    createFlow,
    /InteractionHelper\.safeDefer\(interaction, \{ flags: MessageFlags\.Ephemeral \}\)/,
  );
  assert.doesNotMatch(createFlow, /sendTicketCreationConfirmation\(/);
  assert.match(createFlow, /setResponseLifetime\(interaction, 10_000\)/);
  assert.match(createFlow, /title: 'Ticket created'/);
  assert.match(createFlow, /InteractionHelper\.safeEditReply\(interaction,/);
  assert.match(createFlow, /scheduleTicketReplyDeletion\(interaction, 10_000\)/);
  assert.doesNotMatch(createFlow, /interaction\.channel\.send\(/);
});
