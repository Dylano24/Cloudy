import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db, getTicketData, saveTicketData } from '../src/utils/database.js';
import {
  deleteTicketCreationConfirmation,
  prepareTicketCreationConfirmationCleanup,
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

  assert.equal(await registerPrivateTicketCreationConfirmation(ticketChannel, interaction), true);
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

test('Ticket created cleanup is prepared before deletion and executed only after channel delete succeeds', () => {
  const source = fs.readFileSync('src/services/ticketDeleteService.js', 'utf8');
  const prepareCleanup = source.indexOf('await prepareTicketCreationConfirmationCleanup(');
  const channelDelete = source.indexOf('await channel.delete(', prepareCleanup);
  const confirmationDelete = source.indexOf('await cleanupCreationConfirmation()', channelDelete);

  assert.ok(prepareCleanup >= 0, 'creation confirmation cleanup snapshot must be prepared');
  assert.ok(channelDelete > prepareCleanup, 'ticket channel delete must happen after cleanup preparation');
  assert.ok(
    confirmationDelete > channelDelete,
    'prepared creation confirmation cleanup must run only after successful channel deletion',
  );
});


test('private Ticket created cleanup survives a bot restart while the Discord interaction token is valid', async () => {
  installTestStorage();
  const previousToken = process.env.DISCORD_TOKEN;
  const previousFetch = global.fetch;
  process.env.DISCORD_TOKEN = 'test-discord-token-for-confirmation-encryption';

  try {
    await saveTicketData('guild-restart-confirmation', 'ticket-restart-confirmation', {
      id: 'ticket-restart-confirmation',
      status: 'open',
      userId: 'user-restart-confirmation',
    });

    const ticketChannel = {
      id: 'ticket-restart-confirmation',
      guild: {
        id: 'guild-restart-confirmation',
        channels: { fetch: async () => null },
      },
      client: { user: { id: 'cloudy-bot' } },
    };

    const interaction = {
      applicationId: 'application-restart-confirmation',
      token: 'interaction-restart-token',
      deleteReply: async () => true,
    };

    assert.equal(
      await registerPrivateTicketCreationConfirmation(ticketChannel, interaction),
      true,
    );

    const stored = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
    assert.equal(stored.privateCreationConfirmation.applicationId, interaction.applicationId);
    assert.notEqual(
      stored.privateCreationConfirmation.encryptedInteractionToken,
      interaction.token,
      'interaction token must never be stored in plaintext',
    );

    let deleteUrl = '';
    global.fetch = async (url, options) => {
      deleteUrl = String(url);
      assert.equal(options?.method, 'DELETE');
      return { ok: true, status: 204 };
    };

    // Cache-busting the module simulates a fresh process with an empty in-memory
    // confirmation map, while PostgreSQL-backed ticket data remains available.
    const restarted = await import(
      `../src/services/ticketCreationConfirmationService.js?restart=${Date.now()}`
    );

    assert.equal(
      await restarted.deleteTicketCreationConfirmation(ticketChannel),
      true,
    );
    assert.match(deleteUrl, /application-restart-confirmation/);
    assert.match(deleteUrl, /interaction-restart-token/);

    const afterCleanup = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
    assert.equal(afterCleanup.privateCreationConfirmation, undefined);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = previousToken;
  }
});


test('prepared private Ticket created cleanup does not need a post-delete ticket lookup', async () => {
  installTestStorage();
  await saveTicketData('guild-prepared-confirmation', 'ticket-prepared-confirmation', {
    id: 'ticket-prepared-confirmation',
    status: 'open',
    userId: 'user-prepared-confirmation',
  });

  let deletes = 0;
  const ticketChannel = {
    id: 'ticket-prepared-confirmation',
    guild: { id: 'guild-prepared-confirmation' },
    client: { user: { id: 'cloudy-bot' } },
  };
  const interaction = {
    deleteReply: async () => {
      deletes += 1;
    },
  };

  await registerPrivateTicketCreationConfirmation(ticketChannel, interaction);
  const data = await getTicketData(ticketChannel.guild.id, ticketChannel.id);
  const cleanup = await prepareTicketCreationConfirmationCleanup(ticketChannel, data);

  // Simulate the ticket/channel lifecycle moving on after the cleanup snapshot.
  db.db.get = async () => {
    throw new Error('post-delete lookup should not be required');
  };

  assert.equal(await cleanup(), true);
  assert.equal(deletes, 1);
});
