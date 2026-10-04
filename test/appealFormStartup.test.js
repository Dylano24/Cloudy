import test from 'node:test';
import assert from 'node:assert/strict';
import appealFormReady from '../src/events/appealFormReady.js';

test('Appeal Form startup never posts or replaces an owner-managed embed', () => {
  let touched = false;
  const client = new Proxy({}, {
    get() {
      touched = true;
      throw new Error('Appeal Form startup must not access Discord.');
    },
  });

  assert.equal(appealFormReady.execute(client), undefined);
  assert.equal(touched, false);
});
