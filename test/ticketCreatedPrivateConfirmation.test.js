import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db, saveTicketData } from '../src/utils/database.js';
import {
  deleteTicketCreationConfirmation,
  registerPrivateTicketCreationConfirmation,
} from '../src/services/ticketCreationConfirmationService.js';

function installTestStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
}

test('Ticket created stays private with no short lifetime after successful creation', () => {
  const source = fs.readFileSync('src/interactions/modals/ticket/createTicketUi.js', 'utf8');
  const start = source.indexOf("const createTicketModal =");
  const end = source.indexOf("const closeTicketModal =", start);
  assert.ok(start >= 0 && end > start);
  const createFlow = source.slice(start, end);
  const successStart = createFlow.indexOf('const channelLink = buildTicketChannelLink(channel);');
  const catchStart = createFlow.indexOf('    } catch (error) {', successStart);
  const successFlow = createFlow.slice(successStart, catchStart);

  assert.match(
    createFlow,
    /InteractionHelper\.safeDefer\(interaction, \{ flags: MessageFlags\.Ephemeral \}\)/,
  );
  assert.match(successFlow, /setResponseLifetime\(interaction, null\)/);
  assert.match(successFlow, /title: 'Ticket created'/);
  assert.match(successFlow, /InteractionHelper\.safeEditReply\(interaction,/);
  assert.match(successFlow, /registerPrivateTicketCreationConfirmation\(channel, interaction\)/);
  assert.doesNotMatch(successFlow, /scheduleTicketReplyDeletion/);
  assert.doesNotMatch(successFlow, /interaction\.channel\.send\(/);
});

test('private Ticket created confirmation is registered and removed through delete lifecycle cleanup', async () => {
  installTestStorage();
  await saveTicketData('guild-private-confirmation', 'ticket-private-confirmation', {
    id: 'ticket-private-confirmation',
    status: 'open',
    userId: 'user-private-confirmation',
  });

  let deletes = 0;
  const ticketChannel = {
    id: 'ticket-private-confirmation',
    guild: { id: 'guild-private-confirmation' },
    client: { user: { id: 'cloudy-bot' } },
  };
  const interaction = {
    deleteReply: async () => {
      deletes += 1;
    },
  };

  assert.equal(registerPrivateTicketCreationConfirmation(ticketChannel, interaction), true);
  assert.equal(await deleteTicketCreationConfirmation(ticketChannel), true);
  assert.equal(deletes, 1);
});

test('closing or reconciling a closed ticket does not remove Ticket created confirmation', () => {
  const source = fs.readFileSync('src/services/ticketReliabilityService.js', 'utf8');
  const closeStart = source.indexOf('export async function closeTicket');
  const reopenStart = source.indexOf('export async function reopenTicket', closeStart);
  const closeBody = source.slice(closeStart, reopenStart);
  assert.doesNotMatch(closeBody, /deleteTicketCreationConfirmation/);

  const reconcileStart = source.indexOf('export async function reconcileTicketChannelState');
  const scheduleStart = source.indexOf('export function scheduleTicketReconcile', reconcileStart);
  const reconcileBody = source.slice(reconcileStart, scheduleStart);
  assert.doesNotMatch(reconcileBody, /deleteTicketCreationConfirmation/);
});

test('Ticket created cleanup runs only after the real ticket channel delete succeeds', () => {
  const source = fs.readFileSync('src/services/ticketDeleteService.js', 'utf8');
  const channelDelete = source.indexOf('await channel.delete(');
  const confirmationDelete = source.indexOf('await deleteTicketCreationConfirmation(channel)', channelDelete);

  assert.ok(channelDelete >= 0, 'ticket channel delete call missing');
  assert.ok(
    confirmationDelete > channelDelete,
    'creation confirmation cleanup must happen after successful channel deletion',
  );
});
