import { Events } from 'discord.js';
import { syncSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import {
  applySavedEmbedTemplates,
  saveGlobalEmbedTemplate,
} from '../services/embedTemplateService.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const BATCH_SIZE = 100;
const scheduledGuildSyncs = new Map();
const runningGuildSyncs = new Map();

function embedData(embed) {
  return embed?.toJSON ? embed.toJSON() : (embed || {});
}

function firstLine(value) {
  return String(value || '').split('\n').find(Boolean) || '';
}

async function persistCatalogTemplates(oldMessage, newMessage) {
  const previous = oldMessage?.embeds || [];
  const current = newMessage?.embeds || [];

  for (let index = 0; index < current.length; index += 1) {
    const before = embedData(previous[index]);
    const after = embedData(current[index]);
    if (!after || typeof after !== 'object') continue;

    const aliases = [
      before?.title,
      after?.title,
      firstLine(before?.description),
      firstLine(after?.description),
    ].filter(Boolean);

    const thumbnailChanged = (before?.thumbnail?.url || null) !== (after?.thumbnail?.url || null);
    const imageChanged = (before?.image?.url || null) !== (after?.image?.url || null);

    await saveGlobalEmbedTemplate(
      newMessage.guildId,
      aliases,
      after,
      {
        applyThumbnail: thumbnailChanged,
        applyImage: imageChanged,
      },
    );
  }
}

async function syncGuildHistory(guild) {
  const running = runningGuildSyncs.get(guild.id);
  if (running) return running;

  const job = (async () => {
    let channels = 0;
    let scanned = 0;
    let updated = 0;
    const botUserId = guild.client.user?.id;
    if (!botUserId) return { channels, scanned, updated };

    const textChannels = [...guild.channels.cache.values()]
      .filter(channel => channel?.isTextBased?.() && channel?.messages?.fetch);

    for (const channel of textChannels) {
      let before;
      channels += 1;

      while (true) {
        const batch = await channel.messages.fetch({ limit: BATCH_SIZE, before }).catch(() => null);
        if (!batch?.size) break;

        for (const message of batch.values()) {
          if (message.author?.id !== botUserId || !message.embeds?.length || !message.editable) continue;
          if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) continue;
          scanned += 1;

          const applied = await applySavedEmbedTemplates(message).catch(() => false);
          if (!applied) continue;
          updated += 1;

          const refreshed = await channel.messages.fetch(message.id).catch(() => null);
          if (refreshed) {
            void registerCloudyEmbedMessage(refreshed, 'global-template-history')
              .catch(error => logger.debug(`[EMBED_BUILDER] Global history registry refresh skipped: ${error.message}`));
          }
        }

        const oldest = batch.last();
        if (!oldest || batch.size < BATCH_SIZE) break;
        before = oldest.id;
      }
    }

    logger.warn(`[EMBED_BUILDER] Automatic template history sync: ${channels} channels, ${scanned} bot embeds checked, ${updated} previous messages updated.`);
    return { channels, scanned, updated };
  })();

  runningGuildSyncs.set(guild.id, job);
  try {
    return await job;
  } finally {
    if (runningGuildSyncs.get(guild.id) === job) runningGuildSyncs.delete(guild.id);
  }
}

function scheduleHistorySync(guild) {
  const previous = scheduledGuildSyncs.get(guild.id);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    scheduledGuildSyncs.delete(guild.id);
    void syncGuildHistory(guild).catch(error => {
      logger.warn(`[EMBED_BUILDER] Automatic template history sync failed: ${error.message}`);
    });
  }, 750);
  timer.unref?.();
  scheduledGuildSyncs.set(guild.id, timer);
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message?.guild || String(message.content || '').trim() !== SYSTEM_CATALOG_CONTENT) return;

    const synced = await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`[EMBED_BUILDER] Automatic catalog save sync failed: ${error.message}`);
      return false;
    });
    if (!synced) return;

    await persistCatalogTemplates(oldMessage, message).catch(error => {
      logger.warn(`[EMBED_BUILDER] Could not persist automatic template globally: ${error.message}`);
    });

    scheduleHistorySync(message.guild);
  },
};