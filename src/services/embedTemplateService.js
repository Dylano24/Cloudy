import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';
const GLOBAL_SCOPE = '__global__';
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

async function loadMergedTemplates(guildId, channelId) {
  const [globalTemplates, channelTemplates] = await Promise.all([
    loadTemplates(guildId, GLOBAL_SCOPE),
    loadTemplates(guildId, channelId),
  ]);
  return { ...globalTemplates, ...channelTemplates };
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

function dynamicParts(value = '') {
  const values = [];
  const sentinel = '\u0000CLOUDY_DYNAMIC\u0000';
  let text = String(value || '').replace(/\{dynamic\}/gi, sentinel);

  text = text.replace(
    /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b(?:red|black|green|even|odd|player|banker|tie)\b|\b\d+(?:\.\d+)?\b/gi,
    match => {
      values.push(match);
      return '{dynamic}';
    },
  );

  text = text.replaceAll(sentinel, '{dynamic}');
  return {
    pattern: normalizeKey(text),
    tokenized: text,
    values,
  };
}

function renderDynamic(template, runtime, {
  fallbackToRuntimeOnMismatch = false,
  preserveRuntimeWhenNoDynamic = false,
} = {}) {
  const source = String(runtime || '');
  const templateSource = String(template || '');
  const runtimeParts = dynamicParts(source);
  const templateParts = dynamicParts(templateSource);
  const placeholders = templateParts.tokenized.match(/\{dynamic\}/gi) || [];

  if (!placeholders.length) {
    if (preserveRuntimeWhenNoDynamic && source && source !== templateSource) return source;
    return templateSource;
  }

  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;

  let runtimeIndex = 0;
  let templateIndex = 0;
  const rendered = templateParts.tokenized.replace(/\{dynamic\}/gi, () => {
    const runtimeValue = runtimeParts.values[runtimeIndex++];
    const fallbackValue = templateParts.values[templateIndex++];
    return runtimeValue ?? fallbackValue ?? '{dynamic}';
  });

  return fallbackToRuntimeOnMismatch && /\{dynamic\}/i.test(rendered) ? source : rendered;
}

function aliasKeys(value) {
  const raw = normalizeKey(value);
  const pattern = dynamicParts(value).pattern;
  return [...new Set([raw, pattern].filter(Boolean))];
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function pickTemplate(data = {}, options = {}) {
  const applyTitle = options.applyTitle ?? hasOwn(data, 'title');
  const applyDescription = options.applyDescription ?? hasOwn(data, 'description');
  const applyFields = options.applyFields ?? hasOwn(data, 'fields');
  const applyFooter = options.applyFooter ?? hasOwn(data, 'footer');
  const applyThumbnail = options.applyThumbnail === true;
  const applyImage = options.applyImage === true;
  const fields = Array.isArray(data.fields)
    ? data.fields.slice(0, 25).map(field => ({
        name: String(field?.name || '\u200B').slice(0, 256),
        value: String(field?.value || '\u200B').slice(0, 1024),
        inline: Boolean(field?.inline),
      }))
    : [];

  return {
    applyTitle,
    title: data.title ?? null,
    applyDescription,
    description: data.description ?? null,
    applyFields,
    fields,
    color: Number.isInteger(data.color) ? data.color : null,
    applyFooter,
    footer: data.footer?.text ? { ...data.footer } : null,
    applyThumbnail,
    thumbnail: applyThumbnail && data.thumbnail?.url ? { url: data.thumbnail.url } : null,
    applyImage,
    image: applyImage && data.image?.url ? { url: data.image.url } : null,
  };
}

async function saveTemplate(guildId, scope, matchNames = [], embedData = {}, options = {}) {
  try {
    return await mutateTemplates(guildId, scope, async () => {
      const key = templateKey(guildId, scope);
      const stored = await loadTemplates(guildId, scope);
      const templates = { ...stored };
      const template = pickTemplate(embedData, options);
      const aliases = [
        ...matchNames,
        embedData.title,
        String(embedData.description || '').split('\n').find(Boolean),
      ]
        .flatMap(aliasKeys)
        .filter(Boolean);

      for (const alias of new Set(aliases)) {
        templates[alias] = {
          ...template,
          updatedAt: new Date().toISOString(),
        };
      }

      const saved = await setInDb(key, templates);
      if (!saved) {
        logger.error(`Failed to persist embed template for ${guildId}:${scope}`);
        return false;
      }

      templateCache.set(key, templates);
      return true;
    });
  } catch (error) {
    logger.error('Failed to save embed template:', error);
    return false;
  }
}

export async function saveEmbedTemplateDecoration(guildId, channelId, matchNames = [], embedData = {}, options = {}) {
  return saveTemplate(guildId, channelId, matchNames, embedData, options);
}

export async function saveGlobalEmbedTemplate(guildId, matchNames = [], embedData = {}, options = {}) {
  return saveTemplate(guildId, GLOBAL_SCOPE, matchNames, embedData, options);
}

function findStoredTemplate(data, stored) {
  const candidates = [
    data.title,
    String(data.description || '').split('\n').find(Boolean),
  ]
    .flatMap(aliasKeys)
    .filter(Boolean);

  return candidates.map(candidate => stored[candidate]).find(Boolean) || null;
}

function shouldApply(template, flagName, valueName) {
  if (template?.[flagName] === true) return true;
  if (template?.[flagName] === false) return false;

  // Templates saved before explicit apply flags existed should keep their old
  // non-empty values, but must not erase live content merely because a style-only
  // template did not contain that property.
  const value = template?.[valueName];
  return Array.isArray(value) ? value.length > 0 : value != null;
}

function decorateEmbedData(embed, stored) {
  const original = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  const data = { ...original };
  const template = findStoredTemplate(data, stored);
  if (!template) return { matched: false, changed: false, data };

  if (shouldApply(template, 'applyTitle', 'title')) {
    if (template.title) {
      data.title = renderDynamic(template.title, original.title || '', {
        fallbackToRuntimeOnMismatch: true,
      });
    } else {
      delete data.title;
    }
  }

  if (shouldApply(template, 'applyDescription', 'description')) {
    if (template.description) {
      data.description = renderDynamic(template.description, original.description || '', {
        fallbackToRuntimeOnMismatch: true,
      });
    } else {
      delete data.description;
    }
  }

  if (shouldApply(template, 'applyFields', 'fields')) {
    if (!template.fields?.length) {
      delete data.fields;
    } else {
      const runtimeFields = Array.isArray(original.fields) ? original.fields : [];
      data.fields = template.fields.slice(0, 25).map((templateField, index) => {
        const runtimeField = runtimeFields[index] || {};
        return {
          name: renderDynamic(templateField.name, runtimeField.name || templateField.name, {
            fallbackToRuntimeOnMismatch: true,
          }).slice(0, 256),
          value: renderDynamic(templateField.value, runtimeField.value || templateField.value, {
            fallbackToRuntimeOnMismatch: true,
            preserveRuntimeWhenNoDynamic: true,
          }).slice(0, 1024),
          inline: Boolean(templateField.inline),
        };
      });
    }
  }

  if (Number.isInteger(template.color)) data.color = template.color;

  if (shouldApply(template, 'applyFooter', 'footer')) {
    if (template.footer?.text) {
      data.footer = {
        ...template.footer,
        text: renderDynamic(template.footer.text, original.footer?.text || template.footer.text, {
          fallbackToRuntimeOnMismatch: true,
        }),
      };
    } else {
      delete data.footer;
    }
  }

  // User/member avatars and other event-specific thumbnails stay dynamic unless
  // the administrator explicitly changed/removed the thumbnail in Embed Builder.
  if (template.applyThumbnail === true) {
    if (template.thumbnail?.url) data.thumbnail = { url: template.thumbnail.url };
    else delete data.thumbnail;
  }

  if (template.applyImage === true) {
    if (template.image?.url) data.image = { url: template.image.url };
    else delete data.image;
  }

  return {
    matched: true,
    changed: JSON.stringify(original) !== JSON.stringify(data),
    data,
  };
}

export async function decorateEmbedWithSavedTemplate(guildId, channelId, embed) {
  try {
    const stored = await loadMergedTemplates(guildId, channelId);
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
    const stored = await loadMergedTemplates(message.guildId, message.channelId);
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
    if (!changed) return true;

    const edited = await message.edit({ embeds }).catch(error => {
      logger.debug(`[EMBED_BUILDER] Saved template could not be applied to message ${message.id}: ${error?.message || error}`);
      return null;
    });
    return Boolean(edited);
  } catch (error) {
    logger.error('Failed to apply saved embed templates:', error);
    return false;
  }
}
