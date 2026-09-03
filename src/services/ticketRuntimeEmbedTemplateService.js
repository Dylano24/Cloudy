import { EmbedBuilder } from 'discord.js';
import {
  decorateEmbedWithSavedTemplate,
  saveEmbedTemplateDecoration,
} from './embedTemplateService.js';
import { logger } from '../utils/logger.js';

const TICKET_RUNTIME_TEMPLATE_SCOPE = '__ticket_runtime__';

export function isTicketRuntimeChannel(channel) {
  return /ticket-\d+/i.test(String(channel?.name || ''));
}

function mediaChanges(oldData = {}, newData = {}) {
  return {
    applyThumbnail: (oldData.thumbnail?.url || null) !== (newData.thumbnail?.url || null),
    applyImage: (oldData.image?.url || null) !== (newData.image?.url || null),
  };
}

export async function persistTicketRuntimeTemplates(oldMessage, newMessage) {
  if (!newMessage?.guildId || !isTicketRuntimeChannel(newMessage.channel)) return false;
  if (!newMessage.embeds?.length) return false;

  let savedAny = false;

  for (let index = 0; index < newMessage.embeds.length; index += 1) {
    const newData = newMessage.embeds[index]?.toJSON?.() || {};
    const oldData = oldMessage?.embeds?.[index]?.toJSON?.() || {};
    if (!newData.title && !newData.description) continue;

    const aliases = [oldData.title, newData.title].filter(Boolean);
    const saved = await saveEmbedTemplateDecoration(
      newMessage.guildId,
      TICKET_RUNTIME_TEMPLATE_SCOPE,
      aliases,
      newData,
      mediaChanges(oldData, newData),
    );
    savedAny ||= Boolean(saved);
  }

  return savedAny;
}

export async function applyTicketRuntimeTemplates(message) {
  if (!message?.guildId || !message?.editable || !message?.embeds?.length) return false;
  if (!isTicketRuntimeChannel(message.channel)) return false;

  try {
    let matched = false;
    let changed = false;
    const embeds = [];

    for (const embed of message.embeds) {
      const result = await decorateEmbedWithSavedTemplate(
        message.guildId,
        TICKET_RUNTIME_TEMPLATE_SCOPE,
        embed,
      );
      matched ||= Boolean(result.matched);
      changed ||= Boolean(result.changed);
      embeds.push(result.matched ? result.embed : new EmbedBuilder(embed.toJSON()));
    }

    if (!matched) return false;
    if (!changed) return true;

    const edited = await message.edit({
      embeds,
      components: message.components,
    }).catch(error => {
      logger.debug(`[EMBED_BUILDER] Ticket runtime template could not be applied to message ${message.id}: ${error?.message || error}`);
      return null;
    });

    return Boolean(edited);
  } catch (error) {
    logger.error('Failed to apply ticket runtime embed template:', error);
    return false;
  }
}
