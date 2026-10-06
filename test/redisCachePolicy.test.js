import assert from 'node:assert/strict';
import test from 'node:test';
import { redisCacheTtlForKey } from '../src/utils/database/wrapper.js';

test('Redis accelerates read-heavy Builder state without caching durable economy/ticket truth', () => {
  assert.equal(redisCacheTtlForKey('cloudy:embed-registry:guild-1'), 5 * 60_000);
  assert.equal(redisCacheTtlForKey('cloudy:system-embed-catalog:guild-1'), 15 * 60_000);
  assert.equal(redisCacheTtlForKey('cloudy:embed-reappear-index:guild-1:channel-1'), 60_000);
  assert.equal(redisCacheTtlForKey('cloudy:embed-reappear:guild-1:channel-1:message-1'), 30_000);

  // Financial and ticket state stays PostgreSQL-first; Redis must never become
  // authoritative for balances, purchases, sanctions or ticket lifecycle data.
  assert.equal(redisCacheTtlForKey('guild:guild-1:economy:user-1'), 0);
  assert.equal(redisCacheTtlForKey('guild:guild-1:ticket:123'), 0);
  assert.equal(redisCacheTtlForKey('guild:guild-1:config'), 0);
});
