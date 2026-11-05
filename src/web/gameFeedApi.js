// Link point for the game server feeds: POST /api/game/v1/events with
// "Authorization: Bearer <CLOUDY_GAME_FEED_SECRET>" and { "events": [...] }.
// Without the secret (not linked yet) it answers 503 and posts nothing.
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { MAX_EVENTS_PER_REQUEST, postGameFeedEvents } from '../services/gameFeedService.js';

export const GAME_FEED_PATH = '/api/game/v1/events';

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createGameFeedHandler({ client, env = process.env }) {
  return async function handle(req, res) {
    try {
      const secret = String(env.CLOUDY_GAME_FEED_SECRET || '');
      if (secret.length < 32) return res.status(503).json({ error: 'The game server is not linked yet.', code: 'not_linked' });
      const header = String(req.headers?.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!sameSecret(token, secret)) return res.status(401).json({ error: 'Unauthorized.', code: 'unauthorized' });
      if (!client.isReady?.()) return res.status(503).json({ error: 'Cloudy is starting. Try again in a moment.', code: 'starting' });
      const events = Array.isArray(req.body?.events) ? req.body.events : req.body?.type ? [req.body] : null;
      if (!events?.length) return res.status(400).json({ error: 'Send { "events": [...] }.', code: 'invalid' });
      if (events.length > MAX_EVENTS_PER_REQUEST) {
        return res.status(413).json({ error: `Send at most ${MAX_EVENTS_PER_REQUEST} events at once.`, code: 'too_many' });
      }
      const result = await postGameFeedEvents(client, events);
      return res.status(result.accepted ? 202 : 422).json(result);
    } catch (error) {
      logger.error('[GAME_FEED] Request failed:', error);
      return res.status(500).json({ error: 'Cloudy could not handle these events.', code: 'bot_error' });
    }
  };
}

export function registerGameFeedApi(app, client, express) {
  try {
    app.post(GAME_FEED_PATH, express.json({ limit: '64kb' }), createGameFeedHandler({ client }));
  } catch (error) {
    logger.error('[GAME_FEED] Could not register the game feed API:', error);
  }
}
