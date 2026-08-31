import { Events } from 'discord.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const BATCH_SIZE = 100;
const pending = new Map();
const completed = new Map();

function physicalChannelId(record) {
  return String(record?.backingChannelId || record?.channelId || '');
}

async function wasBuilderTemplateSave(message) {
  const records = await getEmbedRegistry(message.guildId);
  return records.some(record =>
    physicalChannelId(record) === String(message.channelId)
    && String(record.messageId) === String(message.id)
    && String(record.source || '').toLowerCase().includes('modified-template'),
  );
}

async function syncChannelHistory(channel, botUserId) {
  if (!channel?.messages?.fetch) return { scanned: 0, updated: 0 };

  let before;
  let scanned = 0;
  let updated = 0;

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
        void registerCloudyEmbedMessage(refreshed, 'saved-template-history')
          .catch(error => logger.debug(`[EMBED_BUILDER] History template registry refresh skipped: ${error.message}`));
      }
    }

    const oldest = batch.last();
    if (!oldest || batch.size < BATCH_SIZE) break;
    before = oldest.id;
  }

  return { scanned, updated };
}

async function processBuilderSave(message) {
  if (!await wasBuilderTemplateSave(message)) return;

  const fingerprint = JSON.stringify((message.embeds || []).map(embed => embed?.toJSON?.() || embed));
  const key = `${message.guildId}:${message.channelId}:${message.id}`;
  if (completed.get(key) === fingerprint) return;
  completed.set(key, fingerprint);

  const result = await syncChannelHistory(message.channel, message.client.user.id);
  logger.warn(`[EMBED_BUILDER] Saved template synced through #${message.channel?.name || message.channelId}: ${result.scanned} embeds checked, ${result.updated} previous messages updated.`);
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message?.guildId || !message?.client?.user?.id || !message?.embeds?.length) return;
    if (message.author?.id !== message.client.user.id) return;
    if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;

    const key = `${message.guildId}:${message.channelId}:${message.id}`;
    const previous = pending.get(key);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      pending.delete(key);
      void processBuilderSave(message).catch(error => {
        logger.warn(`[EMBED_BUILDER] Previous-message template sync failed: ${error.message}`);
      });
    }, 1200);
    timer.unref?.();
    pending.set(key, timer);
  },
};