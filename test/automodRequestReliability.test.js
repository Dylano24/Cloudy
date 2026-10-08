import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAutomodProtection } from '../src/services/automodProtectionService.js';

test('image moderation requests carry cancellation so an unavailable provider cannot wait forever', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-moderation-key';
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  });
  let options;
  t.mock.method(globalThis, 'fetch', async (_url, requestOptions) => {
    options = requestOptions;
    return { ok: true, json: async () => ({ results: [{ categories: {}, category_scores: {} }] }) };
  });
  const message = {
    id: 'image-moderation-request',
    guild: { id: 'automod-request-guild' },
    channel: { id: 'automod-request-channel' },
    client: { user: { id: 'cloudy' } },
    author: { id: 'image-member' },
    member: { permissions: { has: () => false } },
    content: '',
    attachments: new Map([['image', { contentType: 'image/png', url: 'https://cdn.discordapp.com/test.png' }]]),
  };

  assert.equal(await enforceAutomodProtection(message), false);
  assert.ok(options.signal instanceof AbortSignal, 'provider request must carry an abort signal');
  assert.equal(options.signal.aborted, false);
});
