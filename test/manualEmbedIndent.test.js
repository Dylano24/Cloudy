import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

test('long standard bullet stays byte-for-byte unchanged', () => {
  const input = '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.';
  assert.equal(normalizeManualIndent(input), input);
});

test('long custom emoji bullet stays byte-for-byte unchanged', () => {
  const emoji = '<:W8733476glowingdotred:123456789012345678>';
  const input = `${emoji} The timer is automatically reset while the team is online and remains protected.`;
  assert.equal(normalizeManualIndent(input), input);
});

test('short bullet and normal prose stay unchanged', () => {
  assert.equal(normalizeManualIndent('• Be part of a team.'), '• Be part of a team.');
  assert.equal(normalizeManualIndent('Normal text stays exactly the same.'), 'Normal text stays exactly the same.');
});

test('code fences are not reformatted', () => {
  const input = '```\n• this line inside code must stay untouched even if it is deliberately very long and exceeds the wrapping limit\n```';
  assert.equal(normalizeManualIndent(input), input);
});
