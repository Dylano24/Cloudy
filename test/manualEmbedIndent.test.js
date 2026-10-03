import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

const BLANK = '\u2800';

test('ZORP custom glowing-dot continuations align with three preserved blanks', () => {
  const emoji = '<:W87205667glowingdotwhite:1543291335036108830>';
  const input = [
    `${emoji} The timer is automatically reset while the team is online.`,
    `${emoji} A team cannot create a ZORP zone that overlaps with another team’s zone.`,
    `${emoji} If a player switches teams, their existing ZORP zone will be removed to prevent abuse.`,
    `${emoji} Select \`Good Bye\` to confirm the removal.`,
  ].join('\n');

  const output = normalizeManualIndent(input).split('\n');
  assert.deepEqual(output, [
    `${emoji} The timer is automatically reset while`,
    `${BLANK.repeat(3)}the team is online.`,
    `${emoji} A team cannot create a ZORP zone that`,
    `${BLANK.repeat(3)}overlaps with another team’s zone.`,
    `${emoji} If a player switches teams, their`,
    `${BLANK.repeat(3)}existing ZORP zone will be removed to`,
    `${BLANK.repeat(3)}prevent abuse.`,
    `${emoji} Select \`Good Bye\` to confirm the`,
    `${BLANK.repeat(3)}removal.`,
  ]);
});

test('custom emoji markup is preserved byte-for-byte', () => {
  const emoji = '<a:W8733476glowingdotred:123456789012345678>';
  const input = `${emoji} The timer is automatically reset while the team is online and remains protected.`;
  const output = normalizeManualIndent(input);
  assert.equal(output.split('\n')[0].startsWith(`${emoji} `), true);
  assert.equal(output.includes(emoji), true);
});

test('short bullet and normal prose stay unchanged', () => {
  assert.equal(normalizeManualIndent('• Be part of a team.'), '• Be part of a team.');
  assert.equal(normalizeManualIndent('Normal text stays exactly the same.'), 'Normal text stays exactly the same.');
});

test('code fences are not reformatted', () => {
  const input = '```\n• this line inside code must stay untouched even if it is deliberately very long and exceeds the wrapping limit\n```';
  assert.equal(normalizeManualIndent(input), input);
});
