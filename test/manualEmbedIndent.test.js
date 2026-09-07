import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

test('manual embed text is transported byte-for-byte without server-side wrapping', () => {
  const input = '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.';
  assert.equal(normalizeManualIndent(input), input);
});

test('custom emoji lines are preserved exactly', () => {
  const emoji = '<:W8733476glowingdotred:123456789012345678>';
  const input = `${emoji} The timer is automatically reset while the team is online and remains protected.`;
  assert.equal(normalizeManualIndent(input), input);
});

test('browser-serialized indentation glyphs and ordinary spaces stay untouched', () => {
  const input = '\u2063\u2002\u2800  Manual indent\n    Plain spaces\n\tTab';
  assert.equal(normalizeManualIndent(input), input);
});

test('code fences are not reformatted', () => {
  const input = '```\n• this line inside code must stay untouched even if it is deliberately very long and exceeds the wrapping limit\n```';
  assert.equal(normalizeManualIndent(input), input);
});

test('nullish values still normalize safely to an empty string', () => {
  assert.equal(normalizeManualIndent(null), '');
  assert.equal(normalizeManualIndent(undefined), '');
});
