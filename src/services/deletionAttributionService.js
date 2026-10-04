import { AuditLogEvent } from 'discord.js';

export const AUTOMOD_LOG_CHANNEL_ID = '1556209466679238696';
const intents = new Map();
const auditCounts = new Map();

export function rememberMessageDeleter(message, user, source = 'staff') {
  const key = `${message.guild?.id}:${message.id}`;
  const intent = { id: user?.id, label: source === 'automod' ? 'AutoMod' : user?.id ? `<@${user.id}>` : 'Unknown', source };
  intents.set(key, intent);
  const timer = setTimeout(() => { if (intents.get(key) === intent) intents.delete(key); }, 120_000);
  timer.unref?.();
}

export async function resolveMessageDeleter(message, { bulk = false } = {}) {
  const known = intents.get(`${message.guild.id}:${message.id}`);
  if (known) return known;
  try {
    const logs = await message.guild.fetchAuditLogs({ type: bulk ? AuditLogEvent.MessageBulkDelete : AuditLogEvent.MessageDelete, limit: 10 });
    const matches = [...logs.entries.values()].filter(entry => {
      if (!entry.executor?.id || Date.now() - entry.createdTimestamp > 10_000) return false;
      if (entry.extra?.channel?.id !== message.channelId) return false;
      return bulk || (message.author?.id && entry.target?.id === message.author.id);
    });
    // Never guess between different possible executors. Audit entries do not
    // contain message IDs; unmatched/self deletions remain Unknown.
    if (matches.length !== 1) return { label: 'Unknown', source: 'unknown' };
    const entry = matches[0];
    const key = `${message.guild.id}:${entry.id}`;
    const used = auditCounts.get(key) || 0;
    if (used >= Number(entry.extra?.count || 1)) return { label: 'Unknown', source: 'unknown' };
    auditCounts.set(key, used + 1);
    const timer = setTimeout(() => auditCounts.delete(key), 30_000);
    timer.unref?.();
    return { id: entry.executor.id, label: `<@${entry.executor.id}>`, source: 'audit' };
  } catch { return { label: 'Unknown', source: 'unknown' }; }
}

export function isBotActionFeedback(message) {
  if (!message.author?.bot || message.author.id !== message.client.user?.id) return false;
  if (message.flags?.has?.(64) || (Number(message.flags?.bitfield || message.flags || 0) & 64)) return true;
  return (message.embeds || []).some(embed => /^(?:success|error|warning|permission denied|report submitted|message submitted|messages purged|ticket (?:created|deleted|closed|reopened|claimed|unclaimed)|spam detected|image removed)$/i.test(String(embed.title || embed.data?.title || '').trim()));
}
