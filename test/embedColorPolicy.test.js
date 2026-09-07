import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_NEUTRAL_COLOR, installDefaultEmbedColorPolicy, normalizeDefaultEmbedColor, setPreservedEmbedColor } from '../src/utils/embedColorPolicy.js';

test('green defaults become Cloudy green and other defaults become white', () => {
  assert.equal(normalizeDefaultEmbedColor(0x57F287), CLOUDY_GREEN_COLOR);
  assert.equal(normalizeDefaultEmbedColor('#2ECC71'), CLOUDY_GREEN_COLOR);
  assert.equal(normalizeDefaultEmbedColor('#3498DB'), CLOUDY_NEUTRAL_COLOR);
  assert.equal(normalizeDefaultEmbedColor('#ED4245'), CLOUDY_NEUTRAL_COLOR);
});
test('protected colors bypass the default palette once', () => {
  installDefaultEmbedColorPolicy();
  const embed = new EmbedBuilder();
  setPreservedEmbedColor(embed, 0xFF1493);
  assert.equal(embed.toJSON().color, 0xFF1493);
  embed.setColor(0x3498DB);
  assert.equal(embed.toJSON().color, CLOUDY_NEUTRAL_COLOR);
});
