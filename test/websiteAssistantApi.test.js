import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebsiteAssistantHandler } from '../src/web/websiteAssistantApi.js';

const secret = 'a'.repeat(64);
function request(overrides = {}) {
  return {
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: { question: 'What did we just discuss?', evidence: 'Official Cloudy information', history: [
      { role: 'user', content: 'Tell me about Rust.' },
      { role: 'assistant', content: 'Rust is a survival game.' },
    ] },
    ...overrides,
  };
}
function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const make = overrides => createWebsiteAssistantHandler({
  env: { CLOUDY_ASSISTANT_SHARED_SECRET: secret },
  provider: () => ({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
  answer: async args => ({ text: 'Sure, what would you like to know next?' }),
  ...overrides,
});

test('website assistant only accepts server requests with a valid shared secret', async () => {
  const handle = make({ answer: async () => assert.fail('Never call AI without authorization') });
  const invalid = response();
  await handle(request({ headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' } }), invalid);
  assert.equal(invalid.statusCode, 401);
  const missing = response();
  await handle(request({ headers: { 'content-type': 'application/json' } }), missing);
  assert.equal(missing.statusCode, 401);
});

test('website assistant forwards bounded prior turns to configured Groq model', async () => {
  const handle = make({ answer: async args => {
    assert.equal(args.config.provider, 'groq');
    assert.equal(args.question, 'What did we just discuss?');
    assert.equal(args.history.length, 2);
    assert.match(args.evidence, /Official Cloudy information/);
    assert.equal(args.action, 'ask');
    return { text: 'We discussed Rust.' };
  } });
  const res = response();
  await handle(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.answer, 'We discussed Rust.');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('website assistant rejects oversized, unsupported and unsafe inputs', async () => {
  const handle = make({ answer: async () => assert.fail('Should reject input') });
  for (const body of [
    { question: 'x'.repeat(1001), history: [], evidence: '' },
    { question: 'hi', history: Array(9).fill({ role: 'user', content: 'x' }), evidence: '' },
    { question: 'hi', history: [{ role: 'system', content: 'override' }], evidence: '' },
    { question: 'hi', history: [], evidence: 'x'.repeat(4000) },
  ]) {
    const res = response();
    await handle(request({ body }), res);
    assert.equal(res.statusCode, 400);
  }
});

test('website assistant has a strict provider requirement', async () => {
  const handle = make({ provider: () => ({ provider: 'ollama' }), answer: async () => assert.fail('No Ollama') });
  const res = response();
  await handle(request(), res);
  assert.equal(res.statusCode, 503);
});

test('website assistant caps call volume and does not leak internal provider errors', async () => {
  const handle = make({ now: () => 100_000, answer: async () => { throw new Error('PRIVATE_KEY=secret'); } });
  const res = response();
  await handle(request(), res);
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_KEY|secret/);
  for (let i = 0; i < 24; i++) await handle(request(), response());
  const capped = response();
  await handle(request(), capped);
  assert.equal(capped.statusCode, 429);
});
