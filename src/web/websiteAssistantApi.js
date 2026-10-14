import { timingSafeEqual } from 'node:crypto';
import { answerExplicitAi, getAiProvider } from '../services/explicitAiProvider.js';
import { logger } from '../utils/logger.js';

const MAX_HISTORY = 8;
const MAX_EVIDENCE = 3200;
const MAX_QUESTION = 1000;
const MAX_ACTIVE = 3;
const MAX_PER_MINUTE = 25;
const MAX_PER_DAY = 250;

function matchesSecret(header, secret) {
  if (!secret || secret.length < 32 || typeof header !== 'string') return false;
  const submitted = header.startsWith('Bearer ') ? header.slice(7) : '';
  const left = Buffer.from(submitted);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createWebsiteAssistantHandler({
  answer = answerExplicitAi,
  provider = getAiProvider,
  env = process.env,
  now = Date.now,
} = {}) {
  let minuteStart = 0;
  let requestsThisMinute = 0;
  let dayStart = 0;
  let requestsToday = 0;
  let active = 0;

  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // This endpoint is for Vercel's server only. A browser never receives this key.
    if (!matchesSecret(req.headers?.authorization, env.CLOUDY_ASSISTANT_SHARED_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return res.status(415).json({ error: 'JSON required' });
    }

    const data = req.body;
    const question = typeof data?.question === 'string' ? data.question.trim() : '';
    const evidence = typeof data?.evidence === 'string' ? data.evidence : '';
    const rawHistory = data?.history;
    if (question.length < 2 || question.length > MAX_QUESTION
      || evidence.length > MAX_EVIDENCE
      || !Array.isArray(rawHistory) || rawHistory.length > MAX_HISTORY
      || rawHistory.some(turn => !turn || typeof turn.content !== 'string'
        || turn.content.length > 650 || !['user', 'assistant'].includes(turn.role))) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const time = now();
    const minute = Math.floor(time / 60_000);
    const day = Math.floor(time / 86_400_000);
    if (minute !== minuteStart) { minuteStart = minute; requestsThisMinute = 0; }
    if (day !== dayStart) { dayStart = day; requestsToday = 0; }
    if (active >= MAX_ACTIVE || requestsThisMinute >= MAX_PER_MINUTE || requestsToday >= MAX_PER_DAY) {
      return res.status(429).json({ error: 'Assistant is busy' });
    }

    let config;
    try {
      config = provider();
      if (config.provider !== 'groq') throw new Error('Website AI requires the configured Groq provider');
    } catch {
      return res.status(503).json({ error: 'Assistant is unavailable' });
    }

    requestsThisMinute += 1;
    requestsToday += 1;
    active += 1;
    try {
      const result = await answer({
        question,
        evidence,
        action: 'ask',
        history: rawHistory,
        config,
      });
      if (typeof result?.text !== 'string' || !result.text.trim()) {
        return res.status(502).json({ error: 'Assistant is unavailable' });
      }
      return res.status(200).json({ answer: result.text.slice(0, 3500) });
    } catch (error) {
      const code = error?.code === 'rate_limit' ? 429 : error?.code === 'timeout' ? 504 : 502;
      logger.warn('[WEBSITE_ASSISTANT] Request failed', { status: code });
      return res.status(code).json({ error: code === 429 ? 'Assistant is busy' : 'Assistant is unavailable' });
    } finally {
      active -= 1;
    }
  };
}

export function registerWebsiteAssistantApi(app) {
  app.post('/api/website-assistant/chat', createWebsiteAssistantHandler());
}
