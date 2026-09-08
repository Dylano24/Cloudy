import { runExplicitAi } from './explicitAiService.js';

const recentRequests = new Map();

export function getOwnerAssistantCooldown(userId) {
  const now = Date.now();
  for (const [id, expires] of recentRequests) if (expires <= now) recentRequests.delete(id);
  const remaining = (recentRequests.get(String(userId)) || 0) - now;
  if (remaining > 0) return remaining;
  if (recentRequests.size >= 1000) return 15_000;
  recentRequests.set(String(userId), now + 15_000);
  return 0;
}

export async function createOwnerAssistantHandoff(client, guild, question, actor) {
  // The authenticated Discord actor is mandatory. Text can never authorize a read.
  if (!actor || actor.guild !== guild || actor.client !== client) throw new Error('forbidden');
  return runExplicitAi(actor, question);
}
