import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';

const DOT = '<:W87205667glowingdotwhite:1543291335036108830>';
const SPACER = '<:cloudy_zorp_indent:1556162804598317086> ';

test('non-ZORP editor serialization remains byte-for-byte unchanged', () => {
  const input = '  • **Text**  <:emoji:123>\n\u2063\u2002\u2800Text\n```js\n  code();\n```\n\tEnd';
  assert.equal(normalizeManualIndent(input), input);
});

test('ZORP wraps by rendered width and aligns continuations to the glowing-dot text column', () => {
  const input = [
    DOT + ' The timer is automatically reset while the team is online.',
    DOT + ' A team cannot create a ZORP zone that overlaps with another team’s zone.',
    DOT + ' If a player switches teams, their existing ZORP zone will be removed to prevent abuse.',
    DOT + ' Select `Good Bye` to confirm the removal.',
  ].join('\n');

  const output = normalizeManualIndent(input, { zorp: true });
  assert.deepEqual(output.split('\n'), [
    DOT + ' The timer is automatically reset while the',
    SPACER + 'team is online.',
    DOT + ' A team cannot create a ZORP zone that',
    SPACER + 'overlaps with another team’s zone.',
    DOT + ' If a player switches teams, their existing',
    SPACER + 'ZORP zone will be removed to prevent',
    SPACER + 'abuse.',
    DOT + ' Select `Good Bye` to confirm the removal.',
  ]);
  assert.equal(normalizeManualIndent(output, { zorp: true }), output);
});

test('legacy braille continuation spacing is upgraded to the fixed-width spacer emoji', () => {
  const input = DOT + ' The timer is automatically reset while the\n\u2800\u2800\u2800team is online.';
  const output = normalizeManualIndent(input, { zorp: true });
  assert.equal(output, DOT + ' The timer is automatically reset while the\n' + SPACER + 'team is online.');
});

test('ZORP alignment preserves custom emoji markup byte-for-byte', () => {
  const emoji = '<a:W8733476glowingdotred:123456789012345678>';
  const input = emoji + ' The timer is automatically reset while the team is online and remains protected.';
  const output = normalizeManualIndent(input, { zorp: true });
  assert.equal(output.split('\n')[0].startsWith(emoji + ' '), true);
  assert.equal(output.includes(emoji), true);
});

test('ZORP leaves plain bullets, prose and code fences unchanged', () => {
  assert.equal(normalizeManualIndent('• Be part of a team.', { zorp: true }), '• Be part of a team.');
  assert.equal(normalizeManualIndent('Normal text stays exactly the same.', { zorp: true }), 'Normal text stays exactly the same.');
  const input = '```\n<:W87205667glowingdotwhite:1543291335036108830> this line inside code must stay untouched even if it is deliberately very long\n```';
  assert.equal(normalizeManualIndent(input, { zorp: true }), input);
});
