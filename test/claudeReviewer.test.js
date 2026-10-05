import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeReviewer } from '../src/services/claudeReviewer.js';

const env = { CLOUDY_REVIEW_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key' };
const input = { question: 'Review this diff', evidence: 'const x = 1;' };
const reply = (content = [{ type: 'text', text: 'Review advice' }], stop_reason = 'end_turn') => new Response(JSON.stringify({ content, stop_reason }));

test('disabled/missing key/unsupported model never contact a provider', async () => {
  for (const config of [{}, { CLOUDY_REVIEW_PROVIDER: 'anthropic' }, { ...env, CLOUDY_REVIEW_MODEL: 'another-model' }]) {
    let calls = 0;
    const review = createClaudeReviewer({ env: config, fetchImpl: async () => { calls++; } });
    await assert.rejects(review(input), /disabled|configuration/);
    assert.equal(calls, 0);
  }
});

test('fixed Anthropic route, redacted data, no tools and explicit unapplied result', async () => {
  const review = createClaudeReviewer({ env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'test-key');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'claude-sonnet-5');
    assert.equal(body.max_tokens, 1200);
    assert.equal(body.tools, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.thinking.type, 'disabled');
    assert.match(body.messages[0].content, /REDACTED/);
    return reply();
  } });
  assert.deepEqual(await review({ ...input, evidence: 'api_key="super-secret-value"' }), {
    text: 'Review advice', provider: 'anthropic', model: 'claude-sonnet-5', applied: false,
  });
});

test('invalid/oversized input is rejected before sending', async () => {
  const review = createClaudeReviewer({ env, fetchImpl: () => assert.fail('must not send') });
  for (const value of [{ question: '' }, { ...input, evidence: {} }, { ...input, evidence: 'x'.repeat(24_000) }]) {
    await assert.rejects(review(value), /invalid_request|context_too_large/);
  }
});

test('tool use, incomplete, malformed, empty and oversized responses fail closed', async () => {
  const responses = [
    () => reply([{ type: 'tool_use' }], 'tool_use'),
    () => reply(undefined, 'max_tokens'),
    () => new Response('invalid json'),
    () => reply([{ type: 'text', text: '' }]),
    () => reply([{ type: 'text', text: 'x'.repeat(96_000) }]),
  ];
  for (const fetchImpl of responses) {
    await assert.rejects(createClaudeReviewer({ env, fetchImpl })(input), /unexpected_tool_call|incomplete_response|invalid_response|empty_response|response_too_large/);
  }
});

test('429 blocks follow-up calls; errors never expose provider body or credentials', async () => {
  let time = 0;
  let calls = 0;
  const review = createClaudeReviewer({ env, now: () => time, fetchImpl: async () => {
    calls++;
    return new Response('secret provider error', { status: 429, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(review(input), /^Error: rate_limit$/);
  await assert.rejects(review(input), /rate_limit/);
  assert.equal(calls, 1);
  time = 120_001;
  await assert.rejects(review(input), /rate_limit/);
  assert.equal(calls, 2);
  await assert.rejects(createClaudeReviewer({ env, fetchImpl: async () => { throw new Error('secret'); } })(input), /^Error: provider_unavailable$/);
});

test('concurrent reviews are rejected and the gate releases after completion', async () => {
  let release;
  const review = createClaudeReviewer({ env, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const first = review(input);
  await assert.rejects(review(input), /rate_limit/);
  release(reply());
  await first;
  const next = review(input);
  release(reply());
  await next;
});
