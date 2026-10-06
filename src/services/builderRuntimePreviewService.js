import { getFromDb, setInDb } from '../utils/database.js';
import { removeRetiredGamblingGuideCommand } from '../config/gamblingCommands.js';
import { buildDashboardEmbed } from '../commands/Economy/modules/economy_dashboard.js';
import { buildEconomyLeaderboardEmbed } from '../commands/Economy/eleaderboard.js';

const pending = new Map();
const latest = new Map();
const fingerprints = new Map();
function key(guildId, channelId, title) {
  let value = String(title || '').replace(/\{dynamic\}/gi, '__cloudy_dynamic__');
  value = value.replace(/^([a-z0-9_.-]{2,32})(?='s\b)/i, '__cloudy_dynamic__');
  value = value.replace(
    /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/gi,
    '__cloudy_dynamic__',
  );
  const name = value
    .replace(/<a?:[^:>]+:\d+>/g, '')
    .replace(/[^\p{L}\p{N}\s_]/gu, ' ')
    .replace(/__cloudy_dynamic__/g, 'dynamic')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
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
    const serialized = JSON.stringify(data);
    if (fingerprints.get(storageKey) === serialized) {
      if (pending.has(storageKey)) await pending.get(storageKey);
      return;
    }
    const snapshot = JSON.parse(serialized);
    latest.set(storageKey, snapshot);
    fingerprints.set(storageKey, serialized);
    if (pending.has(storageKey)) { await pending.get(storageKey); return; }
    const job = (async () => {
      let written;
      do {
        written = fingerprints.get(storageKey);
        const saved = await setInDb(storageKey, latest.get(storageKey));
        if (!saved) throw new Error('Runtime preview could not be persisted');
      } while (written !== fingerprints.get(storageKey));
    })();
    pending.set(storageKey, job);
    try { await job; }
    catch (error) { fingerprints.delete(storageKey); throw error; }
    finally { if (pending.get(storageKey) === job) pending.delete(storageKey); }
  }));
}

export async function hydrateBuilderPreviewRecord(guild, record, previewRecord, userId) {
  // LIVE_PREVIEW_WINS_V1: when a real Discord message exists, its current
  // embed is the Builder truth. Runtime snapshots are only fallbacks for
  // catalog/dynamic responses with no live peer.
  const livePreviewSource = String(previewRecord?.source || '').toLowerCase();
  if (previewRecord && !previewRecord.detached && livePreviewSource !== 'system-catalog') {
    return previewRecord;
  }

  const recordSource = String(record?.source || '').toLowerCase();
  if (!record?.detached && recordSource && recordSource !== 'system-catalog') {
    return record;
  }

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
  return { ...record, source: 'runtime-preview', snapshot: removeRetiredGamblingGuideCommand(saved) };
}
