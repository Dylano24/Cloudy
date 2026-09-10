import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  DASHBOARD_IDLE_MS,
  TRANSIENT_MESSAGE_MS,
  deleteLifecycleMessage,
  isDashboardSessionPayload,
  isEphemeralLifecycleMessage,
  normalizeDashboardCollectorOptions,
} from '../src/utils/interactionMessageLifecycle.js';

test('dashboard and transient lifetimes use the requested values', () => {
  assert.equal(DASHBOARD_IDLE_MS, 5 * 60_000);
  assert.equal(TRANSIENT_MESSAGE_MS, 10_000);
});

test('ephemeral dashboard sessions are recognized without matching persistent panels by title alone', () => {
  const dashboard = {
    flags: { has: flag => flag === MessageFlags.Ephemeral },
    embeds: [{ title: 'Ticket System Dashboard' }],
    components: [{ components: [{ customId: 'ticket_dashboard_channel' }] }],
  };

  assert.equal(isEphemeralLifecycleMessage(null, dashboard), true);
  assert.equal(isDashboardSessionPayload(null, dashboard), true);

  const publicPanel = {
    flags: { has: () => false },
    embeds: [{ title: 'Verification' }],
    components: [{ components: [{ customId: 'verification_start' }] }],
  };

  assert.equal(isEphemeralLifecycleMessage(null, publicPanel), false);
});

test('join to create configuration is a managed dashboard session', () => {
  assert.equal(isDashboardSessionPayload({
    embeds: [{ title: 'Join to create configuration' }],
    components: [{ components: [{ custom_id: 'jtc_config_name_123' }] }],
  }), true);
});

test('five minute dashboard collectors become inactivity collectors', () => {
  const dashboard = {
    flags: { has: flag => flag === MessageFlags.Ephemeral },
    embeds: [{ title: 'Join to create configuration' }],
    components: [{ components: [{ customId: 'jtc_config_name_123' }] }],
  };
  const original = { componentType: 2, time: DASHBOARD_IDLE_MS };
  const normalized = normalizeDashboardCollectorOptions(dashboard, original);

  assert.equal(normalized.time, undefined);
  assert.equal(normalized.idle, DASHBOARD_IDLE_MS);
  assert.equal(original.time, DASHBOARD_IDLE_MS);

  const publicPanel = {
    flags: { has: () => false },
    embeds: [{ title: 'Join to create configuration' }],
    components: dashboard.components,
  };
  assert.equal(normalizeDashboardCollectorOptions(publicPanel, original), original);
});

test('ephemeral cleanup uses webhook deletion before normal message deletion', async () => {
  let webhookDeletes = 0;
  let directDeletes = 0;
  const message = {
    id: 'ephemeral-dashboard',
    delete: async () => {
      directDeletes += 1;
      throw new Error('normal delete must not be required for ephemeral replies');
    },
  };
  const interaction = {
    webhook: {
      deleteMessage: async id => {
        assert.equal(id, message.id);
        webhookDeletes += 1;
      },
    },
  };

  assert.equal(await deleteLifecycleMessage(message, interaction), true);
  assert.equal(webhookDeletes, 1);
  assert.equal(directDeletes, 0);
});

test('cleanup falls back to a normal delete for public messages', async () => {
  let directDeletes = 0;
  const message = {
    id: 'public-message',
    delete: async () => {
      directDeletes += 1;
    },
  };

  assert.equal(await deleteLifecycleMessage(message, {}), true);
  assert.equal(directDeletes, 1);
});
