import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';
const templateCache = new Map();
const templateMutationQueues = new Map();

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function templateKey(guildId, channelId) {
  return `${TEMPLATE_PREFIX}${guildId}:${channelId}`;
}

function cleanTemplates(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadTemplates(guildId, channelId) {
  const key = templateKey(guildId, channelId);
  if (templateCache.has(key)) return templateCache.get(key);

  const templates = cleanTemplates(await getFromDb(key, {}));
  templateCache.set(key, templates);
  return templates;
}

async function mutateTemplates(guildId, channelId, operation) {
  const key = templateKey(guildId, channelId);
  const previous = templateMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  templateMutationQueues.set(key, current);

  try {
    return await current;
  } finally {
    if (templateMutationQueues.get(key) === current) templateMutationQueues.delete(key);
  }
}

function pickDecoration(data = {}, options = {}) {
  const applyThumbnail = options.applyThumbnail === true;
  const applyImage = options.applyImage === true;

  return {
    title: data.title || null,
    color: Number.isInteger(data.color) ? data.color : null,
    footer: data.footer?.text ? { ...data.footer } : null,
    applyThumbnail,
    thumbnail: applyThumbnail && data.thumbnail?.url ? { url: data.thumbnail.url } : null,
    applyImage,
    image: applyImage && data.image?.url ? { url: data.image.url } : null,
  };
}

export async function saveEmbedTemplateDecoration(guildId, channelId, matchNames = [], embedData = {}, options = {}) {
  try {
    return await mutateTemplates(guildId, channelId, async () => {
      const key = templateKey(guildId, channelId);
      const stored = await loadTemplates(guildId, channelId);
      const templates = { ...stored };
      const decoration = pickDecoration(embedData, options);
      const aliases = [...new Set(matchNames.map(normalizeKey).filter(Boolean))];

      for (const alias of aliases) {
        templates[alias] = {
          ...decoration,
          updatedAt: new Date().toISOString(),
        };
      }

      const saved = await setInDb(key, templates);
      if (!saved) {
        logger.error(`Failed to persist embed template decoration for ${guildId}:${channelId}`);
        return false;
      }

      templateCache.set(key, templates);
      return true;
    });
  } catch (error) {
    logger.error('Failed to save embed template decoration:', error);
    return false;
  }
}

function decorateEmbedData(embed, stored) {
  const data = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  const candidates = [data.title, String(data.description || '').split('\n').find(Boolean)]
    .map(normalizeKey)
    .filter(Boolean);
  const template = candidates.map(candidate => stored[candidate]).find(Boolean);
  if (!template) return { matched: false, changed: false, data };

  if (template.title) data.title = template.title;
  else delete data.title;

  if (Number.isInteger(template.color)) data.color = template.color;

  if (template.footer?.text) data.footer = { ...template.footer };
  else delete data.footer;

  // User/member avatars and other event-specific thumbnails must stay dynamic.
  if (template.applyThumbnail === true) {
    if (template.thumbnail?.url) data.thumbnail = { url: template.thumbnail.url };
    else delete data.thumbnail;
  }

  if (template.applyImage === true) {
    if (template.image?.url) data.image = { url: template.image.url };
    else delete data.image;
  }

  const original = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  return { matched: true, changed: JSON.stringify(original) !== JSON.stringify(data), data };
}

export async function decorateEmbedWithSavedTemplate(guildId, channelId, embed) {
  try {
    const stored = await loadTemplates(guildId, channelId);
    const result = decorateEmbedData(embed, stored);
    return {
      matched: result.matched,
      changed: result.changed,
      embed: result.matched ? new EmbedBuilder(result.data) : embed,
    };
  } catch (error) {
    logger.error('Failed to decorate embed with saved template:', error);
    return { matched: false, changed: false, embed };
  }
}

export async function applySavedEmbedTemplates(message) {
  if (!message?.guildId || !message?.channelId || !message?.editable || !message?.embeds?.length) return false;

  try {
    const stored = await loadTemplates(message.guildId, message.channelId);
    if (!Object.keys(stored).length) return false;

    let matched = false;
    let changed = false;
    const embeds = message.embeds.map(embed => {
      const result = decorateEmbedData(embed, stored);
      if (!result.matched) return embed;
      matched = true;
      changed ||= result.changed;
      return new EmbedBuilder(result.data);
    });

    if (!matched) return false;
    if (changed) await message.edit({ embeds }).catch(() => null);
    return true;
  } catch (error) {
    logger.error('Failed to apply saved embed templates:', error);
    return false;
  }
}
