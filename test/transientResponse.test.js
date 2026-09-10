import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { isTransientStatusEmbed } from '../src/utils/transientResponse.js';

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

test('normal and detailed embeds are not classified as transient', () => {
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Timeout log')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Shop commands')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Staff reviews')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Warning').setImage('https://example.com/image.png')), false);
});
