import { AuditLogEvent, Events } from 'discord.js';

const CUTOFF = Date.parse('2026-08-31T22:00:00.000Z'); // Sep 1 00:00 Europe/Amsterdam

function clean(value) {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    try { return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)); }
    catch { return String(value); }
  }
  return value;
}

async function fetchRecent(guild, type) {
  const logs = await guild.fetchAuditLogs({ type, limit: 100 }).catch(error => {
    console.log(`[CHANNEL_RECOVERY_AUDIT] fetch failed guild=${guild.id} type=${type} error=${error?.message || error}`);
    return null;
  });
  if (!logs) return [];
  return [...logs.entries.values()].filter(entry => Number(entry.createdTimestamp || 0) >= CUTOFF);
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        for (const guild of client.guilds.cache.values()) {
          for (const [label, type] of [
            ['CHANNEL_UPDATE', AuditLogEvent.ChannelUpdate],
            ['CHANNEL_CREATE', AuditLogEvent.ChannelCreate],
            ['CHANNEL_DELETE', AuditLogEvent.ChannelDelete],
            ['OVERWRITE_CREATE', AuditLogEvent.ChannelOverwriteCreate],
            ['OVERWRITE_UPDATE', AuditLogEvent.ChannelOverwriteUpdate],
            ['OVERWRITE_DELETE', AuditLogEvent.ChannelOverwriteDelete],
          ]) {
            const entries = await fetchRecent(guild, type);
            for (const entry of entries) {
              const target = entry.target;
              console.log(`[CHANNEL_RECOVERY_AUDIT] ${label} time=${new Date(entry.createdTimestamp).toISOString()} targetId=${entry.targetId || target?.id || ''} name=${JSON.stringify(target?.name || '')} executor=${entry.executorId || entry.executor?.id || ''} changes=${JSON.stringify((entry.changes || []).map(change => ({ key: change.key, old: clean(change.old), new: clean(change.new) })))}`);
            }
            console.log(`[CHANNEL_RECOVERY_AUDIT] ${label} count=${entries.length}`);
          }
        }
        console.log('[CHANNEL_RECOVERY_AUDIT] complete');
      })().catch(error => console.error('[CHANNEL_RECOVERY_AUDIT] failed', error));
    }, 8_000);
    timer.unref?.();
  },
};
