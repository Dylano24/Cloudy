import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMassActionUserIds } from '../src/utils/parseMassActionUserIds.js';

const a = '1532882647838228724';
const b = '1532882647838228725';
const c = '1532882647838228726';

test('mass moderation accepts mentions and plain IDs, processing duplicates only once', () => {
  assert.deepEqual(
    parseMassActionUserIds([a, '<@' + b + '>', '<@!' + a + '>', c, b].join(', ')),
    [a, b, c],
  );
});

test('mass moderation ignores malformed targets and retains the first 20 unique IDs', () => {
  const ids = Array.from({ length: 24 }, (_, i) => (1532882647838228800n + BigInt(i)).toString());
  const result = parseMassActionUserIds([
    'not-an-id', '123', '<@invalid>', ...ids.slice(0, 5),
    ...ids, ids[0], ids[1],
  ].join(','));
  assert.deepEqual(result, ids.slice(0, 20));
});

test('empty inputs do not accidentally produce moderation targets', () => {
  assert.deepEqual(parseMassActionUserIds(' , \n<@abc>'), []);
  assert.deepEqual(parseMassActionUserIds(null), []);
});
