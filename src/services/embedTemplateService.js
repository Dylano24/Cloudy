import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function templateKey(guildId, channelId) {
  return `${TEMPLATE_PREFIX}${guildId}:${channelId}`;
}

function pickDecoration(data = {}) {
  return {
    title: data.title || null,
    color: Number.isInteger(data.color) ? data.color : null,
    thumbnail: data.thumbnail?.url ? { url: data.thumbnail.url } : null,
    footer: data.footer?.text ? { ...data.footer } : null,
    image: data.image?.url ? { url: data.image.url } : null,
    timestamp: data.timestamp || null,
  };
}

export async function saveEmbedTemplateDecoration(guildId, channelId, matchNames = [], embedData = {}) {
  try {
    const key = templateKey(guildId, channelId);
    const stored = await getFromDb(key, {});
    const templates = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    const decoration = pickDecoration(embedData);
    const aliases = [...new Set(matchNames.map(normalizeKey).filter(Boolean))];

    for (const alias of aliases) {
      templates[alias] = {
        ...decoration,
        updatedAt: new Date().toISOString(),
      };
    }

    await setInDb(key, templates);
    return true;
  } catch (error) {
    logger.error('Failed to save embed template decoration:', error);
    return false;
  }
}

export async function applySavedEmbedTemplates(message) {
  if (!message?.guildId || !message?.channelId || !message?.editable || !message?.embeds?.length) return false;

  try {
    const stored = await getFromDb(templateKey(message.guildId, message.channelId), {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !Object.keys(stored).length) return false;

    let changed = false;
    const embeds = message.embeds.map(embed => {
      const data = embed.toJSON();
      const candidates = [data.title, String(data.description || '').split('\n').find(Boolean)].map(normalizeKey).filter(Boolean);
      const template = candidates.map(candidate => stored[candidate]).find(Boolean);
      if (!template) return embed;

      if (template.title) data.title = template.title;
      else delete data.title;

      if (Number.isInteger(template.color)) data.color = template.color;
      if (template.thumbnail?.url) data.thumbnail = { url: template.thumbnail.url };
      else delete data.thumbnail;
      if (template.footer?.text) data.footer = { ...template.footer };
      else delete data.footer;
      if (template.image?.url) data.image = { url: template.image.url };
      else delete data.image;
      if (template.timestamp) data.timestamp = template.timestamp;
      else delete data.timestamp;

      changed = true;
      return new EmbedBuilder(data);
    });

    if (!changed) return false;
    await message.edit({ embeds }).catch(() => null);
    return true;
  } catch (error) {
    logger.error('Failed to apply saved embed templates:', error);
    return false;
  }
}
