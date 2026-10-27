import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installDiscordRestSafeguards } from '../src/utils/discordRestSafeguards.js';

const route = '/channels/123456789012345678/messages/987654321098765432';

function createRest() {
  const rest = new EventEmitter();
  const calls = [];
  rest.request = (method, path, options) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ method, path, options, resolve, reject });
    return promise;
  };
  return { rest, calls };
}

test('identical overlapping PATCH edits are coalesced, with fresh edits sent after completion', async () => {
  const { rest, calls } = createRest();
  let coalesced = 0;
  assert.equal(installDiscordRestSafeguards(rest, { onCoalesced: () => coalesced++ }), true);
  assert.equal(installDiscordRestSafeguards(rest), true, 'installation is idempotent');
  const one = rest.request('PATCH', route, { body: { content: 'Same' }, files: [] });
  const two = rest.request('PATCH', route, { body: { content: 'Same' }, files: [] });
  assert.equal(calls.length, 1);
  assert.equal(coalesced, 1);
  calls[0].resolve({ id: 'updated' });
  assert.deepEqual(await Promise.all([one, two]), [{ id: 'updated' }, { id: 'updated' }]);
  await Promise.resolve();
  const three = rest.request('PATCH', route, { body: { content: 'Same' }, files: [] });
  assert.equal(calls.length, 2, 'after completion a new edit must still go to Discord');
  calls[1].resolve({ id: 'updated-again' });
  assert.deepEqual(await three, { id: 'updated-again' });
});

test('A -> B -> A preserves all distinct intermediate edits', async () => {
  const { rest, calls } = createRest();
  installDiscordRestSafeguards(rest);
  const a = rest.request('PATCH', route, { body: { content: 'A' } });
  const b = rest.request('PATCH', route, { body: { content: 'B' } });
  const again = rest.request('PATCH', route, { body: { content: 'A' } });
  assert.equal(calls.length, 3);
  calls.forEach((call, index) => call.resolve(index));
  assert.deepEqual(await Promise.all([a, b, again]), [0, 1, 2]);
});

test('interaction, delete, create, attachments and unmatched PATCH are never coalesced', async () => {
  const { rest, calls } = createRest();
  installDiscordRestSafeguards(rest);
  const requests = [
    rest.request('POST', '/interactions/123/callback', { body: { type: 4 } }),
    rest.request('POST', '/interactions/123/callback', { body: { type: 4 } }),
    rest.request('DELETE', route),
    rest.request('DELETE', route),
    rest.request('POST', '/channels/123456789012345678/messages', { body: { content: 'hi' } }),
    rest.request('POST', '/channels/123456789012345678/messages', { body: { content: 'hi' } }),
    rest.request('PATCH', route, { body: { content: 'hi' }, files: [{ name: 'a' }] }),
    rest.request('PATCH', route, { body: { content: 'hi' }, files: [{ name: 'a' }] }),
    rest.request('PATCH', '/guilds/123456789012345678', { body: { name: 'hi' } }),
    rest.request('PATCH', '/guilds/123456789012345678', { body: { name: 'hi' } }),
  ];
  assert.equal(calls.length, requests.length);
  calls.forEach(call => call.resolve(null));
  await Promise.all(requests);
});

test('a rejected identical edit propagates to both callers and a retry sends again', async () => {
  const { rest, calls } = createRest();
  installDiscordRestSafeguards(rest);
  const a = rest.request('PATCH', route, { body: { content: 'x' } });
  const b = rest.request('PATCH', route, { body: { content: 'x' } });
  const error = new Error('Discord rejected PATCH');
  calls[0].reject(error);
  assert.deepEqual(await Promise.allSettled([a, b]), [
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  const c = rest.request('PATCH', route, { body: { content: 'x' } });
  assert.equal(calls.length, 2);
  calls[1].resolve('ok');
  assert.equal(await c, 'ok');
});

test('rate limit diagnostics are sanitized, throttled and cannot affect requests', () => {
  const { rest } = createRest();
  const events = [];
  let time = 10_000;
  installDiscordRestSafeguards(rest, {
    now: () => time,
    onRateLimit: event => events.push(event),
  });
  rest.emit('rateLimited', {
    method: 'PATCH', route, scope: 'shared', retryAfter: 1300,
  });
  rest.emit('rateLimited', {
    method: 'PATCH', route, scope: 'shared', retryAfter: 1300,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/channels/:id/messages/:id');
  assert.equal(events[0].retryAfterMs, 1300);
  assert.equal(events[0].scope, 'shared');
  time += 30_000;
  rest.emit('rateLimited', { method: 'PATCH', route, scope: 'shared', retryAfter: 200 });
  assert.equal(events.length, 2);
});
