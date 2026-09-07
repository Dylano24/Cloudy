import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

const BLANK = '\u2800';

test('standard bullet uses explicit hanging indent on long lines', () => {
  const input = '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.';
  const result = normalizeManualIndent(input).split('\n');

  assert.ok(result.length > 1);
  assert.ok(result[0].startsWith('• '));
  assert.ok(result[1].startsWith(BLANK.repeat(2)));
  assert.equal(result.join(' ').replaceAll(BLANK, '').replace(/\s+/g, ' ').trim(), input.replace(/\s+/g, ' ').trim());
});

test('selected custom glowing dot uses same hanging indent', () => {
  const emoji = '<:W8733476glowingdotred:123456789012345678>';
  const input = `${emoji} The timer is automatically reset while the team is online and remains protected.`;
  const result = normalizeManualIndent(input).split('\n');

  assert.ok(result.length > 1);
  assert.ok(result[0].startsWith(`${emoji} `));
  assert.ok(result[1].startsWith(BLANK.repeat(2)));
});

test('short bullet and normal prose stay unchanged', () => {
  assert.equal(normalizeManualIndent('• Be part of a team.'), '• Be part of a team.');
  assert.equal(normalizeManualIndent('Normal text stays exactly the same.'), 'Normal text stays exactly the same.');
});

test('code fences are not reformatted', () => {
  const input = '```\n• this line inside code must stay untouched even if it is deliberately very long and exceeds the wrapping limit\n```';
  assert.equal(normalizeManualIndent(input), input);
});
