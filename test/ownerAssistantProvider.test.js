import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCloudyOwnerRole } from '../src/services/ownerRoleAccess.js';

const originalFetch = globalThis.fetch;
const originalOpenAI = process.env.OPENAI_API_KEY;
const originalGroq = process.env.GROQ_API_KEY;
let version = 0;
async function setup(t, mock) {
  process.env.OPENAI_API_KEY = 'test'; process.env.GROQ_API_KEY = 'test';
  globalThis.fetch = mock;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalGroq;
  });
  return import(`../src/services/ownerAssistantProvider.js?test=${++version}`);
}
const response = (data, status = 200) => ({ ok: status === 200, status, headers: new Headers(), json: async () => data });
const answer = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

test('Owner role required: administrator and server ownership do not grant access', () => {
  const make = names => ({ member: { roles: { cache: { some: fn => names.some(name => fn({ name })) } } }, guild: { ownerId: '1' }, user: { id: '1' } });
  assert.equal(hasCloudyOwnerRole(make(['Admin', 'Founder'])), false);
  assert.equal(hasCloudyOwnerRole(make(['OWNER'])), true);
  assert.equal(hasCloudyOwnerRole(make(['Owner Assistant'])), false);
  assert.equal(hasCloudyOwnerRole({}), false);
});

test('general question answers without context retrieval and uses account-discovered model', async t => {
  const { answerWithProviders } = await setup(t, async (url, options) => {
    if (url.endsWith('/models')) return response({ data: [{ id: 'gpt-4.1' }] });
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-4.1'); assert.equal(body.reasoning, undefined);
    return response(answer('4'));
  });
  const result = await answerWithProviders({ question: '2+2?', systemPrompt: 'Be helpful', retrieve: () => assert.fail('Unnecessary retrieval') });
  assert.equal(result.text, '4');
});

test('targeted retrieval is bounded even with huge Unicode evidence', async t => {
  let round = 0;
  const { answerWithProviders } = await setup(t, async (url, options) => {
    if (url.endsWith('/models')) return response({ data: [{ id: 'gpt-4.1' }] });
    const body = JSON.parse(options.body);
    assert.ok(Buffer.byteLength(body.input) <= 8000);
    if (!round++) return response({ output: [{ type: 'function_call', name: 'retrieve_context', arguments: JSON.stringify({ section: 'logs', query: 'ticket timeout' }) }] });
    assert.match(body.input, /Retrieved evidence/);
    return response(answer('Diagnosis'));
  });
  let retrievals = 0;
  const result = await answerWithProviders({ question: 'Cloudy ticket timeout', systemPrompt: 'Be helpful', retrieve: async (section, query) => {
    retrievals++; assert.equal(section, 'logs'); assert.equal(query, 'ticket timeout'); return '😀'.repeat(100000);
  } });
  assert.equal(result.text, 'Diagnosis'); assert.equal(retrievals, 1);
});

test('OpenAI network failure reaches small Groq fallback; repeat is rate-gated', async t => {
  let groqCalls = 0;
  const { answerWithProviders } = await setup(t, async (url, options) => {
    if (url.includes('openai.com')) throw new TypeError('network failure');
    groqCalls++;
    const body = JSON.parse(options.body);
    assert.ok(Buffer.byteLength(options.body) + body.max_completion_tokens + 512 <= 7000);
    return response({ choices: [{ message: { content: 'Fallback answer' } }] });
  });
  const args = { question: '😀'.repeat(10000), systemPrompt: 'x'.repeat(4000), retrieve: async () => '' };
  assert.equal((await answerWithProviders(args)).diagnostics.provider, 'groq');
  await assert.rejects(answerWithProviders(args), /local_rate_budget/);
  assert.equal(groqCalls, 1);
});

test('OpenAI 404 tries another discovered model', async t => {
  const { answerWithProviders } = await setup(t, async (url, options) => {
    if (url.endsWith('/models')) return response({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-4.1' }] });
    const body = JSON.parse(options.body);
    return body.model === 'gpt-5.6-sol' ? response({ error: { code: 'model_not_found' } }, 404) : response(answer('OK'));
  });
  assert.equal((await answerWithProviders({ question: 'Hi', systemPrompt: 'Help', retrieve: async () => '' })).diagnostics.model, 'gpt-4.1');
});

test('429 is not retried and empty responses can fall back', async t => {
  let openCalls = 0;
  const { answerWithProviders } = await setup(t, async (url) => {
    if (url.endsWith('/models')) return response({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }] });
    if (url.includes('openai.com')) { openCalls++; return response({ error: { code: 'rate_limit_exceeded' } }, 429); }
    return response({ choices: [{ message: { content: 'OK' } }] });
  });
  assert.equal((await answerWithProviders({ question: 'Hi', systemPrompt: 'Help', retrieve: async () => '' })).diagnostics.provider, 'groq');
  assert.equal(openCalls, 1);
});
