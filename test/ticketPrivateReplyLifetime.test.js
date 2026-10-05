import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';

import { setResponseLifetime } from '../src/utils/responseLifetime.js';
import { shouldUseTicketPrivateTransientTimer } from '../src/utils/interactionMessageLifecycle.js';

const ephemeralMessage = {
  flags: {
    has(flag) {
      return flag === MessageFlags.Ephemeral;
    },
  },
  components: [],
};

test('Ticket created is the only persistent private ticket confirmation', () => {
  const interaction = { customId: 'create_ticket_modal' };
  setResponseLifetime(interaction, null);

  assert.equal(
    shouldUseTicketPrivateTransientTimer(
      interaction,
      {
        flags: MessageFlags.Ephemeral,
        embeds: [{ title: 'Ticket created' }],
        components: [],
      },
      ephemeralMessage,
    ),
    false,
  );
});

test('other private ticket status replies use the 10-second transient lifecycle', () => {
  for (const [customId, title] of [
    ['ticket_claim', 'Ticket claimed'],
    ['ticket_unclaim', 'Ticket unclaimed'],
    ['ticket_reopen', 'Ticket reopened'],
    ['ticket_delete', 'Ticket deleted'],
    ['ticket_priority_select', 'Priority Updated'],
    ['ticket_close_modal', 'Ticket close failed'],
  ]) {
    assert.equal(
      shouldUseTicketPrivateTransientTimer(
        { customId },
        {
          flags: MessageFlags.Ephemeral,
          embeds: [{ title }],
          components: [],
        },
        ephemeralMessage,
      ),
      true,
      customId,
    );
  }
});

test('ticket dashboards and public ticket messages do not get the private 10-second rule', () => {
  assert.equal(
    shouldUseTicketPrivateTransientTimer(
      { customId: 'ticket_dashboard_open' },
      {
        flags: MessageFlags.Ephemeral,
        embeds: [{ title: 'Ticket dashboard' }],
        components: [{
          components: [{ custom_id: 'ticket_dashboard_refresh' }],
        }],
      },
      {
        ...ephemeralMessage,
        components: [{
          components: [{ custom_id: 'ticket_dashboard_refresh' }],
        }],
      },
    ),
    false,
  );

  assert.equal(
    shouldUseTicketPrivateTransientTimer(
      { customId: 'ticket_reopen' },
      {
        embeds: [{ title: 'Ticket reopened' }],
        components: [],
      },
      { flags: 0, components: [] },
    ),
    false,
  );
});
