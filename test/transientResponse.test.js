import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  isPersistentBotMessage,
  isTransientStatusContent,
  isTransientStatusEmbed,
  isTransientStatusPayload,
  scheduleTransientMessageDeletion,
  scheduleTransientInteractionReplyDeletion,
} from '../src/utils/transientResponse.js';
import { setResponseLifetime } from '../src/utils/responseLifetime.js';
import { scheduleTicketReplyDeletion } from '../src/utils/ticket/ticketBranding.js';

test('small status replies are transient', () => {
  for (const title of [
    'Success',
    'Warning',
    'Error',
    'Invalid input',
    'Permission denied',
    'Expired',
    'Shop unavailable',
    'Staff only',
    'Maintenance mode',
    'Feature disabled',
    'Slash command only',
    'Command disabled',
    'Command cooldown',
    'Wrong channel',
    '✅ Success',
    '❌ Error',
    '⚠️ Warning',
    'ℹ️ Information',
  ]) {
    assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle(title).setDescription('Short reply')), true);
  }
});

test('content-only command feedback is transient', () => {
  for (const content of [
    '✅ Saved successfully.',
    '❌ You need Manage Server permission to use these controls.',
    '⚠️ Warning: this action is unavailable.',
    'ℹ️ Information: setting updated.',
    'Invalid value. Try again.',
    'Could not update the setting.',
    'No active Join to Create channel is configured.',
    'Choose one of the Staff members first, then select your rating.',
  ]) {
    assert.equal(isTransientStatusContent(content), true);
    assert.equal(isTransientStatusPayload({ content }), true);
  }
});

test('normal and detailed embeds are not classified as transient', () => {
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Timeout log')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Shop commands')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Staff reviews')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Warning').setImage('https://example.com/image.png')), false);
  assert.equal(isTransientStatusContent('Your current balance is $10,000.'), false);
});

test('log, report and review channels are protected from generic bot-message cleanup', () => {
  for (const channelName of ['botlog', 'ticket-logs', 'ticket-transcripts', 'reports', 'posted-reviews', 'staff-reviews']) {
    assert.equal(isPersistentBotMessage({ channel: { name: channelName } }), true);
  }
  assert.equal(isPersistentBotMessage({ channel: { name: 'general' } }), false);
});

test('additional command acknowledgements and validation replies delete at ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deleted = 0;
  const titles = ['Messages Purged', 'Changes Saved', 'Channel Updated', 'Cash Added', 'Role Reward Added',
    'Verification Configured', 'Ticket Setting Updated', 'Birthday Removed', 'Database Error', 'No Birthdays Found',
    'Joined Voice Channel', 'Paused', 'Priority Updated', 'Counter Created Successfully'];
  for (const title of titles) {
    const message = { embeds: [{ title, fields: [{ name: 'Setting', value: 'A' }, { name: 'Value', value: 'B' }] }],
      channel: { name: 'general' }, deletable: true, delete: async () => { deleted += 1; } };
    assert.equal(scheduleTransientMessageDeletion(message), true, title);
  }
  const content = 'This ticket dashboard is outdated. Run `/ticket dashboard` again.';
  const reply = { content, channel: { name: 'general' } };
  assert.equal(await scheduleTransientInteractionReplyDeletion({ replied: true, fetchReply: async () => reply,
    deleteReply: async () => { deleted += 1; } }), true);
  scheduleTicketReplyDeletion({ deleteReply: async () => { deleted += 1; } });
  t.mock.timers.tick(9_999);
  assert.equal(deleted, 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deleted, titles.length + 2);
});

test('explicit report lifetime and permanent response override never get a second short timer', async () => {
  for (const lifetime of [120_000, null]) {
    const interaction = { replied: true, fetchReply: async () => ({ embeds: [{ title: 'Success' }] }) };
    setResponseLifetime(interaction, lifetime);
    assert.equal(await scheduleTransientInteractionReplyDeletion(interaction), false);
  }
});

test('games, ticket notices, guides, content panels, report records and dashboards keep their exceptions', () => {
  for (const title of ['Begging Successful', 'Daily Claimed', 'Fishing Success', 'Crime Failed', 'Work Complete',
    'Payment Successful', 'Ticket created', 'Ticket closed', 'Ticket claimed', 'Ticket unclaimed', 'ZORP Guide',
    'Content Creators', 'Giveaway Started', 'Giveaway Ended', 'Ticket Dashboard', 'Counting Game Status', 'Confirm Stop']) {
    assert.equal(isTransientStatusPayload({ embeds: [{ title }] }), false, title);
  }
  for (const name of ['reports', 'owner-mod-message-logs', 'member-message-logs', 'ticket-logs']) {
    assert.equal(scheduleTransientMessageDeletion({ embeds: [{ title: 'Success' }], channel: { name },
      deletable: true, delete: async () => {} }), false, name);
  }
});
