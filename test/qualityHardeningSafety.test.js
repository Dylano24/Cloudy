import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWinners } from '../src/services/giveawayService.js';
import { checkRateLimit, clearAllRateLimits } from '../src/utils/rateLimiter.js';
import { logger } from '../src/utils/logger.js';

test('giveaway winner selection uses secure randomness and never repeats a participant', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Insecure random generator was called'); });
  const participants = ['alice', 'bob', 'alice', 'charlie', 'dana'];
  const winners = selectWinners(participants, 3);
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners).size, winners.length);
  assert.ok(winners.every(name => participants.includes(name)));
  assert.deepEqual(selectWinners([], 3), []);
  assert.equal(selectWinners(participants, 99).length, 4);
  assert.throws(() => selectWinners(participants, 0), /Invalid winner count/);
});

test('rate limiting fails closed if diagnostic logging throws', async t => {
  clearAllRateLimits();
  t.after(() => clearAllRateLimits());
  t.mock.method(logger, 'debug', () => { throw new Error('Logger unexpectedly unavailable'); });
  const key = 'quality-audit:limit-logging-error';
  assert.equal(await checkRateLimit(key, 1, 60_000), true);
  assert.equal(await checkRateLimit(key, 1, 60_000), false,
    'a logging failure must never permit another request');
});
