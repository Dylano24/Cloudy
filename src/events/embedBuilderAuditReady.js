import { Events } from 'discord.js';
import { getEmbedRegistry, getEmbedRegistrySnapshot } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const TARGET_ID = '1532882647838228723';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      try {
        let guild = client.guilds.cache.get(TARGET_ID) || null;
        let targetKind = guild ? 'guild' : null;
        let targetChannel = null;

        if (!guild) {
          for (const candidate of client.guilds.cache.values()) {
            const channel = candidate.channels.cache.get(TARGET_ID) || null;
            if (channel) {
              guild = candidate;
              targetChannel = channel;
              targetKind = 'channel';
              break;
            }
          }
        }

        if (!guild) {
          logger.warn(`[EMBED_BUILDER_AUDIT] target ${TARGET_ID} was not found as a cached guild or channel`);
          return;
        }

        const records = await getEmbedRegistry(guild.id);
        logger.warn(`[EMBED_BUILDER_AUDIT] target=${TARGET_ID} kind=${targetKind} guild=${guild.id} name=${clean(guild.name)} records=${records.length}${targetChannel ? ` channel=${targetChannel.id}:${clean(targetChannel.name)}` : ''}`);

        const byChannel = new Map();
        for (const record of records) {
          const logicalId = String(record.channelId || '');
          if (!byChannel.has(logicalId)) byChannel.set(logicalId, []);
          byChannel.get(logicalId).push(record);
        }

        const interesting = /ticket|contact|support|assistant|gambl|casino|roulette|blackjack|baccarat/i;
        for (const [logicalId, channelRecords] of byChannel) {
          const logicalChannel = guild.channels.cache.get(logicalId) || null;
          const logicalName = clean(logicalChannel?.name || 'unknown');
          const recordText = channelRecords.map(record => `${clean(record.name)} ${clean(record.title)}`).join(' ');
          if (!interesting.test(`${logicalName} ${recordText}`)) continue;

          logger.warn(`[EMBED_BUILDER_AUDIT] CHANNEL logical=${logicalId}:${logicalName} count=${channelRecords.length}`);
          for (const record of channelRecords) {
            const backingId = String(record.backingChannelId || record.channelId || '');
            const backing = guild.channels.cache.get(backingId) || null;
            const snapshot = getEmbedRegistrySnapshot(record) || {};
            const title = clean(snapshot.title || record.title || record.name || 'Untitled embed');
            const author = clean(snapshot.author?.name || '');
            logger.warn(`[EMBED_BUILDER_AUDIT] RECORD logical=${logicalId}:${logicalName} backing=${backingId}:${clean(backing?.name || 'unknown')} source=${clean(record.source)} message=${record.messageId}:${record.embedIndex || 0} title=${title} author=${author}`);
          }
        }

        const duplicateMap = new Map();
        for (const record of records) {
          const snapshot = getEmbedRegistrySnapshot(record) || {};
          const title = clean(snapshot.title || record.title || record.name || '').toLowerCase();
          if (!title) continue;
          const key = `${record.channelId}|${title}`;
          if (!duplicateMap.has(key)) duplicateMap.set(key, []);
          duplicateMap.get(key).push(record);
        }
        for (const [key, duplicates] of duplicateMap) {
          if (duplicates.length < 2) continue;
          const [logicalId, title] = key.split('|');
          const logicalChannel = guild.channels.cache.get(logicalId) || null;
          logger.warn(`[EMBED_BUILDER_AUDIT] DUP logical=${logicalId}:${clean(logicalChannel?.name || 'unknown')} title=${title} count=${duplicates.length} sources=${duplicates.map(item => clean(item.source)).join(',')}`);
        }
      } catch (error) {
        logger.error(`[EMBED_BUILDER_AUDIT] failed: ${error?.stack || error}`);
      }
    }, 7000);
    timer.unref?.();
  },
};
