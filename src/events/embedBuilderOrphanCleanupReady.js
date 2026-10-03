import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const STARTUP_DELAY_MS = 5_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CHANNEL = 3;
const PAGE_DELAY_MS = 75;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function componentIds(components = []) {
  return components.flatMap(row => {
    const data = row?.toJSON?.() || row || {};
    return (data.components || []).map(component => {
      const item = component?.toJSON?.() || component || {};
      return String(item.custom_id || item.customId || '');
    });
  });
}

export function isOrphanedEmbedBuilderMessage(message, botUserId, olderThan = Number.POSITIVE_INFINITY) {
  if (!message?.id || String(message.author?.id || '') !== String(botUserId || '')) return false;
  if (Number.isFinite(olderThan)
      && Number.isFinite(Number(message.createdTimestamp))
      && Number(message.createdTimestamp) >= olderThan) {
    return false;
  }

  const titles = (message.embeds || [])
    .map(embed => String((embed?.toJSON?.() || embed || {}).title || '').trim().toLowerCase());

  const hasBuilderTitle = titles.includes('message builder') || titles.includes('modify embed');
  if (!hasBuilderTitle) return false;

  return componentIds(message.components || []).some(id => id.startsWith('simple_embed_'));
}

function readableTextChannels(guild) {
  const me = guild.members.me;
  return [...guild.channels.cache.values()]
    .filter(channel =>
      (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      && channel.messages?.fetch
      && channel.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
    )
    .sort((a, b) => a.position - b.position);
}

export async function removeOrphanedEmbedBuilders(guild, botUserId, olderThan = Number.POSITIVE_INFINITY) {
  let scanned = 0;
  let removed = 0;

  for (const channel of readableTextChannels(guild)) {
    let before;

    for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page += 1) {
      const batch = await channel.messages.fetch({ limit: PAGE_SIZE, before }).catch(() => null);
      if (!batch?.size) break;

      scanned += batch.size;
      const stale = [...batch.values()].filter(message =>
        isOrphanedEmbedBuilderMessage(message, botUserId, olderThan),
      );

      for (const message of stale) {
        const deleted = await message.delete()
          .then(() => true)
          .catch(() => false);
        if (deleted) removed += 1;
      }

      const oldest = batch.last();
      if (!oldest || batch.size < PAGE_SIZE) break;
      before = oldest.id;
      await wait(PAGE_DELAY_MS);
    }
  }

  return { scanned, removed };
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    // Anything created after this process became ready belongs to the current
    // process and must never be considered an orphan by this startup sweep.
    const orphanCutoff = Date.now();

    const timer = setTimeout(async () => {
      try {
        let scanned = 0;
        let removed = 0;

        for (const guild of client.guilds.cache.values()) {
          const result = await removeOrphanedEmbedBuilders(guild, client.user.id, orphanCutoff);
          scanned += result.scanned;
          removed += result.removed;
        }

        if (removed > 0) {
          logger.info(`[EMBED_BUILDER] Removed ${removed} orphaned Builder message(s) after restart/deploy (scanned ${scanned}).`);
        }
      } catch (error) {
        logger.error('[EMBED_BUILDER] Failed to clean orphaned Builder messages after restart/deploy:', error);
      }
    }, STARTUP_DELAY_MS);

    timer.unref?.();
  },
};
