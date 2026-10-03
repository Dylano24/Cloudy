import { getFromDb, setInDb } from '../utils/database.js';
import { buildDashboardEmbed } from '../commands/Economy/modules/economy_dashboard.js';
import { buildEconomyLeaderboardEmbed } from '../commands/Economy/eleaderboard.js';

const pending = new Map();
const latest = new Map();
function key(guildId, channelId, title) {
  const name = String(title || '').replace(/<a?:[^:>]+:\d+>/g, '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const canonical = ({ 'currency added': 'add currency', 'currency removed': 'remove currency' })[name] || name;
  return `cloudy:builder-runtime-preview:${guildId}:${channelId}:${canonical}`;
}

export async function rememberBuilderRuntimePreview(payload, source) {
  const guildId = source?.guildId || source?.channel?.guild?.id;
  const channelId = source?.channelId || source?.channel?.id;
  if (!guildId || !channelId || !Array.isArray(payload?.embeds)) return;
  const embeds = payload.embeds.map(embed => embed?.toJSON ? embed.toJSON() : embed);
  if (embeds.some(embed => /^(?:message builder|modify embed)$/i.test(String(embed?.title || '')))) return;
  await Promise.all(embeds.map(async data => {
    if (!data?.title || /^cloudy template key:/i.test(String(data.author?.name || ''))) return;
    if (!data.description && !data.fields?.length) return;
    const storageKey = key(guildId, channelId, data.title);
    const snapshot = JSON.parse(JSON.stringify(data));
    latest.set(storageKey, snapshot);
    const previous = pending.get(storageKey) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => setInDb(storageKey, snapshot));
    pending.set(storageKey, job);
    try { await job; } finally { if (pending.get(storageKey) === job) pending.delete(storageKey); }
  }));
}

export async function hydrateBuilderPreviewRecord(guild, record, previewRecord, userId) {
  if (!record) return previewRecord;
  const snapshot = record.snapshot || {};
  const title = snapshot.title || record.title || record.name;
  if (/^economy leaderboard$/i.test(String(title || '').trim())) {
    const embed = await buildEconomyLeaderboardEmbed(guild.client, guild.id, userId);
    return { ...record, source: 'runtime-preview', snapshot: embed.toJSON() };
  }
  if (/^economy dashboard$/i.test(String(title || '').replace(/[^\p{L}\p{N}\s]/gu, '').trim())) {
    const embed = await buildDashboardEmbed(guild, guild.client);
    return { ...record, source: 'runtime-preview', snapshot: embed.toJSON() };
  }
  const storageKey = key(guild.id, record.channelId, title);
  const saved = latest.get(storageKey) || await getFromDb(storageKey, null);
  if (!saved) return previewRecord;
  return { ...record, source: 'runtime-preview', snapshot: saved };
}
