import test from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_CONTACT_EMOJI, updateStaffContactButtonEmoji } from '../src/events/staffTeamReady.js';

test('staff Contact us gets the custom mail emoji while other buttons stay unchanged', () => {
  const rows = [{ type: 1, components: [
    { type: 2, style: 5, label: 'Contact us', emoji: { name: '✉️' }, url: 'https://discord.com/channels/123/456' },
    { type: 2, style: 5, label: 'FAQ', url: 'https://discord.com/channels/123/789' },
  ] }];
  const original = structuredClone(rows);
  const result = updateStaffContactButtonEmoji(rows);
  assert.equal(result.updated, true);
  assert.deepEqual(result.components[0].components[0].emoji, STAFF_CONTACT_EMOJI);
  assert.deepEqual(result.components[0].components[1], rows[0].components[1]);
  assert.deepEqual(rows, original);
  assert.equal(updateStaffContactButtonEmoji(result.components).updated, false);
});
