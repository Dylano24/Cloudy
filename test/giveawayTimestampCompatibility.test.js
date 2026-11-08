import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGiveawayTimestamp, giveawayEndTime, createGiveawayEmbed,
} from '../src/services/giveawayService.js';
import { getEndedGiveaways } from '../src/utils/database.js';

const GUILD = '1532882647838228723';
const MS = Date.parse('2026-11-08T19:45:30+01:00');
const messageId = id => '156900000000000000' + id;

test('giveaway countdown accepts epoch numbers, numeric strings, ISO dates, and Date values', () => {
  const forms = [MS, String(MS), new Date(MS), new Date(MS).toISOString(), '2026-11-08T19:45:30+01:00'];
  for (const value of forms) {
    assert.equal(parseGiveawayTimestamp(value), MS);
    assert.equal(giveawayEndTime({ endsAt: value }), MS);
    const embed = createGiveawayEmbed({
      endsAt: value, prize: 'Prize', participants: [], winnerCount: 1,
    });
    assert.match(embed.description, new RegExp('<t:' + Math.floor(MS / 1000) + ':F>'));
    assert.match(embed.description, new RegExp('<t:' + Math.floor(MS / 1000) + ':R>'));
  }
});

test('invalid/empty expiry falls back to legacy endTime, never to 1970', () => {
  const inputs = ['', 0, null, undefined, 'nonsense', '2026-15-75', NaN, new Date('invalid')];
  for (const value of inputs) {
    assert.equal(parseGiveawayTimestamp(value), 0, String(value));
    assert.equal(giveawayEndTime({ endsAt: value, endTime: MS }), MS);
  }
  assert.equal(giveawayEndTime({ endsAt: 'not a date', endTime: 'wrong too' }), 0);
});

test('automatic KV expiry finds due giveaway regardless of timestamp format and ignores corrupt dates', async () => {
  const now = Date.now();
  const due = now - 90_000;
  const future = now + 900_000;
  const items = [
    { messageId: messageId('1'), endsAt: due, ended: false },
    { messageId: messageId('2'), endsAt: new Date(due).toISOString(), ended: false },
    { messageId: messageId('3'), endsAt: 'broken', endTime: String(due), ended: false },
    { messageId: messageId('4'), endsAt: new Date(future).toISOString(), ended: false },
    { messageId: messageId('5'), endsAt: 'invalid', ended: false },
    { messageId: messageId('6'), endsAt: due, ended: true },
  ];
  const client = {
    db: {
      list: async prefix => prefix === 'guild:' ? [`guild:${GUILD}:giveaways`] : [],
      get: async () => items,
      isDegraded: () => true,
    },
  };
  const ended = await getEndedGiveaways(client);
  assert.deepEqual(ended.map(x=>x.message_id), [messageId('1'),messageId('2'),messageId('3')]);
  for (const item of ended) {
    assert.equal(Number.isFinite(item.ends_at.getTime()), true);
    assert.ok(item.ends_at.getTime()<=now);
  }
});
