import test from 'node:test';
import assert from 'node:assert/strict';
import { polishZorpGuideData } from '../src/services/zorpGuideService.js';

const DOT = '<:W87205667glowingdotwhite:1543291335036108830>';
const HANG = '\u2800\u2800\u2800';

test('polished ZORP guide uses the supplied custom emoji and exact hanging indents', () => {
  const original = {
    title: '<:cloudy_terms_icon:1540000000000000000> ZORP Guide',
    description: 'Keep this intro.',
    color: 0xFFFFFF,
    fields: [
      { name: '\u200b\nHow to claim a ZORP zone', value: 'old', inline: false },
      { name: '\u200b\nImportant information', value: 'old', inline: false },
      { name: '\u200b\nHow to remove a ZORP zone', value: 'old', inline: false },
      { name: '\u200b\nZone colors', value: '<:cloudy_zorp_white:1> **White**\nKeep colors.', inline: false },
    ],
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };

  const result = polishZorpGuideData(original, DOT);
  assert.equal(result.title, original.title);
  assert.equal(result.description, original.description);
  assert.deepEqual(result.footer, original.footer);
  assert.equal(result.fields[3].value, original.fields[3].value);
  assert.equal(result.fields[0].value.split('\n')[0], `${DOT} To create a ZORP zone, the player must:`);
  assert.ok(result.fields[1].value.includes(`${DOT} The timer is automatically reset while\n${HANG}the team is online.`));
  assert.ok(result.fields[1].value.includes(`${DOT} If a player switches teams, their existing\n${HANG}ZORP zone will be removed to prevent\n${HANG}abuse.`));
  assert.ok(result.fields[2].value.endsWith(`${DOT} Select \`Good Bye\` to confirm the\n${HANG}removal.`));
});

test('polish is deterministic and does not mutate its input', () => {
  const original = { fields: [{ name: 'Important information', value: 'old', inline: false }] };
  const snapshot = structuredClone(original);
  const first = polishZorpGuideData(original, DOT);
  const second = polishZorpGuideData(original, DOT);
  assert.deepEqual(first, second);
  assert.deepEqual(original, snapshot);
});
