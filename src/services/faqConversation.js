import { redactAiText } from './aiSafety.js';

const MAX_SESSIONS = 600;
const TTL_MS = 30 * 60_000;
const MAX_TURNS = 4;
const MAX_QUESTION_CHARS = 650;
const MAX_ANSWER_CHARS = 1100;

// Conversation context is kept only in this bot process, never shared between users.
// It expires after inactivity and is cleared on restart.
export function createFaqConversationStore({ now = Date.now } = {}) {
  const sessions = new Map();

  function keyFor(actor) {
    const guild = actor?.guildId || actor?.guild?.id;
    const channel = actor?.channelId || actor?.channel?.id;
    const user = actor?.user?.id || actor?.author?.id;
    return guild && channel && user ? `${guild}:${channel}:${user}` : null;
  }

  function prune() {
    const timestamp = now();
    for (const [key, session] of sessions) {
      if (timestamp - session.updatedAt >= TTL_MS) sessions.delete(key);
    }
  }

  function history(actor) {
    const key = keyFor(actor);
    if (!key) return [];
    prune();
    const session = sessions.get(key);
    if (!session) return [];
    return session.turns.flatMap(turn => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]);
  }

  function remember(actor, question, answer) {
    const key = keyFor(actor);
    if (!key) return;
    prune();
    const session = sessions.get(key) || { turns: [], updatedAt: now() };
    session.turns.push({
      question: redactAiText(question).slice(0, MAX_QUESTION_CHARS),
      answer: redactAiText(answer).slice(0, MAX_ANSWER_CHARS),
    });
    session.turns = session.turns.slice(-MAX_TURNS);
    session.updatedAt = now();
    sessions.delete(key);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(key, session);
  }

  function reset(actor) {
    const key = keyFor(actor);
    if (key) sessions.delete(key);
  }

  return { history, remember, reset };
}

export const faqConversation = createFaqConversationStore();
