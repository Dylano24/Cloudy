import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { isTransientStatusEmbed } from '../src/utils/transientResponse.js';

test('small status replies are transient', () => {
  for (const title of ['Success', 'Warning', 'Error', 'Invalid input', 'Permission denied', 'Expired']) {
    assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle(title).setDescription('Short reply')), true);
  }
});

test('normal and detailed embeds are not classified as transient', () => {
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Timeout log')), false);
  assert.equal(isTransientStatusEmbed(new EmbedBuilder().setTitle('Warning').setImage('https://example.com/image.png')), false);
});
