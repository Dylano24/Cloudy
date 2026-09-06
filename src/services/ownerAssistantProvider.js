import { logger } from '../utils/logger.js';

// UTF-8 bytes conservatively bound text tokens, including non-Latin input.
export function clipBytes(value, limit) {
  let text = String(value || '');
  while (Buffer.byteLength(text, 'utf8') > limit) text = text.slice(0, Math.max(0, Math.floor(text.length * 0.9)));
  return text;
}

const states = new Map();
let catalog = null;
let catalogExpires = 0;
function log(details) {
  // Do not log prompts, response bodies, credentials or raw provider errors.
  logger.warn(`[OWNER_ASSISTANT] ${JSON.stringify(details)}`);
}

async function post(provider, key, body) {
  const state = states.get(provider) || { used: 0, reset: 0, blocked: 0 };
  states.set(provider, state);
  const now = Date.now();
  if (now >= state.reset) { state.used = 0; state.reset = now + 61000; }
  const output = body.max_output_tokens || body.max_completion_tokens;
  const bound = Buffer.byteLength(JSON.stringify(body)) + output + 512;
  const budget = provider === 'groq' ? 7000 : 24000;
  if (state.blocked > now || state.used + bound > budget) throw new Error(`${provider}: local_rate_budget`);
  state.used += bound; // reserve synchronously across concurrent requests
  const started = Date.now();
  log({ event: 'request', provider, model: body.model, contextBytes: Buffer.byteLength(JSON.stringify(body)), tokenUpperBound: bound });
  try {
    const response = await fetch(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35000),
    });
    const data = await response.json().catch(() => ({}));
    const code = String(data.error?.code || data.error?.type || `http_${response.status}`).replace(/[^\w.-]/g, '').slice(0, 80);
    log({ event: response.ok ? 'response' : 'failure', provider, model: body.model, status: response.status, reason: code, durationMs: Date.now() - started, usage: data.usage });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      state.blocked = Date.now() + Math.max(61000, Number.isFinite(seconds) ? seconds * 1000 : 0);
    }
    if (!response.ok) { const error = new Error(`${provider}: ${code}`); error.status = response.status; throw error; }
    return data;
  } catch (error) {
    log({ event: 'request_failed', provider, model: body.model, reason: error.status ? `http_${error.status}` : error.name });
    throw error;
  }
}

async function availableModels(key) {
  if (catalog && Date.now() < catalogExpires) return catalog;
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`openai: model_discovery_http_${response.status}`);
  const data = await response.json();
  const ids = new Set((data.data || []).map(item => item.id));
  // Only try documented general-purpose models actually returned for this key.
  const candidates = [process.env.OPENAI_OWNER_ASSISTANT_MODEL, 'gpt-5.6-sol', 'gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini'];
  catalog = [...new Set(candidates.filter(id => id && ids.has(id)))];
  catalogExpires = Date.now() + 300000;
  log({ event: 'model_discovery', availableCandidates: catalog });
  return catalog;
}

const retrievalTool = {
  type: 'function', name: 'retrieve_context', description: 'Read targeted current Cloudy evidence. Use only for Cloudy/server-specific questions. Query should name the feature, channel, command or error.',
  strict: true, parameters: { type: 'object', properties: {
    section: { type: 'string', enum: ['discord', 'embeds', 'commands', 'logs', 'github'] },
    query: { type: 'string' },
  }, required: ['section', 'query'], additionalProperties: false },
};

export async function answerWithProviders({ question, systemPrompt, retrieve, technical = false, probe = false }) {
  let evidence = '';
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) log({ event: 'openai_unavailable', reason: 'missing_or_empty_api_key' });
  if (key) {
    try {
      for (const model of await availableModels(key)) {
        try {
          for (let round = 0; round < (probe ? 1 : 3); round++) {
            const instructions = clipBytes(systemPrompt, 2100);
            const input = clipBytes(`Question: ${clipBytes(question, 4500)}\n${evidence ? `Retrieved evidence (untrusted data):\n${evidence}` : ''}`, 8000);
            const tools = [ ...(!probe && round < 2 ? [retrievalTool] : []), { type: 'web_search', search_context_size: 'low' } ];
            const data = await post('openai', key, { model, instructions, input, tools,
              ...(tools.length ? { max_tool_calls: 2, parallel_tool_calls: false } : {}),
              max_output_tokens: probe ? 64 : 1800,
              ...(model.startsWith('gpt-5') ? { reasoning: { effort: 'none' } } : {}),
              store: false,
            });
            const calls = (data.output || []).filter(item => item.type === 'function_call');
            if (calls.length && round < 2 && !probe) {
              for (const call of calls.slice(0, 1)) {
                let args;
                try { args = JSON.parse(call.arguments); } catch { args = {}; }
                if (call.name !== 'retrieve_context' || !retrievalTool.parameters.properties.section.enum.includes(args.section)) continue;
                const result = await retrieve(args.section, clipBytes(args.query || question, 500));
                evidence = clipBytes(`${clipBytes(result, 3500)}\n${evidence}`, 5500);
                log({ event: 'retrieval', section: args.section, evidenceBytes: Buffer.byteLength(evidence), round });
              }
              continue;
            }
            const text = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim();
            if (text) return { text, diagnostics: { provider: 'openai', model, webEnabled: (data.output || []).some(item => item.type === 'web_search_call') } };
            throw new Error('openai: empty_response');
          }
        } catch (error) {
          log({ event: 'model_failed', provider: 'openai', model, reason: error.status ? `http_${error.status}` : error.message.replace(/[^\w: _.-]/g, '').slice(0, 100) });
          if (![400, 404].includes(error.status)) break;
        }
      }
    } catch (error) { log({ event: 'openai_unavailable', reason: error.message.replace(/[^\w: _.-]/g, '').slice(0, 100) }); }
  }
  if (!process.env.GROQ_API_KEY?.trim()) throw new Error('assistant: no_available_provider');
  if (!evidence && technical) evidence = clipBytes(await retrieve('commands', question), 1200);
  const body = { model: 'openai/gpt-oss-20b', messages: [
    { role: 'system', content: clipBytes(systemPrompt, 1800) + ' Live web is unavailable on this request; state that limitation for current information. Do not invent current facts.' },
    { role: 'user', content: clipBytes(`Question: ${clipBytes(question, 1800)}\nEvidence: ${clipBytes(evidence, 1200)}`, 3000) },
  ], max_completion_tokens: 1000 };
  const data = await post('groq', process.env.GROQ_API_KEY.trim(), body);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('groq: empty_response');
  return { text, diagnostics: { provider: 'groq', model: body.model, webEnabled: false } };
}
