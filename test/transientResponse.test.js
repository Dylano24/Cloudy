import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  isPersistentBotMessage,
  isTransientStatusContent,
  isTransientStatusEmbed,
  isTransientStatusPayload,
} from '../src/utils/transientResponse.js';

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
  ]) {
    assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle(title).setDescription('Short reply')), true);
  }
});

test('content-only command feedback is transient', () => {
  for (const content of [
    '✅ Saved successfully.',
    '❌ You need Manage Server permission to use these controls.',
    'Invalid value. Try again.',
    'Could not update the setting.',
    'No active Join to Create channel is configured.',
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
