import { PRESERVE_EXISTING_EMBEDS } from './existingEmbedPolicy.js';
import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { migrateCloudyLogoEmbedData } from './cloudyLogoService.js';
import { stripBlackjackCardsRemaining } from '../utils/blackjackEmbedPresentation.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';
const GLOBAL_SCOPE = '__global__';
const templateCache = new Map();
const templateLoads = new Map();
const templateMutationQueues = new Map();
// A Save must affect the very next bot response, even when its database write
// is still queued. These overlays are folded into persistent cache reads and
// disappear once the matching write succeeds.
const templateOverlays = new Map();

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function templateKey(guildId, channelId) {
  return `${TEMPLATE_PREFIX}${guildId}:${channelId}`;
}

function cleanTemplates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, template]) => [
    key,
    migrateCloudyLogoEmbedData(template).data || template,
  ]));
}

async function loadTemplates(guildId, channelId) {
  const key = templateKey(guildId, channelId);
  if (templateCache.has(key)) return templateCache.get(key);

  if (templateLoads.has(key)) return templateLoads.get(key);
  const job = (async () => {
    const templates = cleanTemplates(await getFromDb(key, {}));
    templateCache.set(key, templates);
    return templates;
  })();
  templateLoads.set(key, job);
  try { return await job; } finally { if (templateLoads.get(key) === job) templateLoads.delete(key); }
}

async function loadMergedTemplates(guildId, channelId) {
  const [globalTemplates, channelTemplates] = await Promise.all([
    loadTemplates(guildId, GLOBAL_SCOPE),
    loadTemplates(guildId, channelId),
  ]);
  const globalOverlay = templateOverlays.get(templateKey(guildId, GLOBAL_SCOPE)) || {};
  const channelOverlay = templateOverlays.get(templateKey(guildId, channelId)) || {};
  return {
    ...globalTemplates,
    ...globalOverlay,
    ...channelTemplates,
    ...channelOverlay,
  };
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

  text = text.replace(/^([a-z0-9_.-]{2,32})(?='s\b)/i, match => {
    values.push(match);
    return '{dynamic}';
  });

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
  // A wholly variable body represents the complete response, including text.
  if (templateSource.trim().toLowerCase() === '{dynamic}') return source;
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

function pickTemplate(data = {}, options = {}) {
  const applyThumbnail = options.applyThumbnail === true;
  const applyImage = options.applyImage === true;
  const applyFields = options.applyFields !== false;
  const hasDescription = Object.prototype.hasOwnProperty.call(data, 'description');
  const edited = options.editedEmbedData || data;
  const fields = applyFields && Array.isArray(data.fields)
    ? data.fields.slice(0, 25).map(field => ({
        name: String(field?.name || '\u200B').slice(0, 256),
        value: String(field?.value || '\u200B').slice(0, 1024),
        inline: Boolean(field?.inline),
      }))
    : [];

  return {
    schemaVersion: 3,
    applyDescription: options.baseEmbedData
      ? (edited.description ?? null) !== (options.baseEmbedData.description ?? null)
      : options.applyDescription !== false,
    applyFields: applyFields && Array.isArray(data.fields) && (options.baseEmbedData
      ? JSON.stringify(edited.fields || []) !== JSON.stringify(options.baseEmbedData.fields || [])
      : true),
    applyFooter: options.baseEmbedData
      ? (data.footer?.text || null) !== (options.baseEmbedData.footer?.text || null)
      : options.applyFooter !== false && (hasDescription || Object.prototype.hasOwnProperty.call(data, 'footer')),
    title: data.title ?? null,
    // Omitted means "leave the live description alone". An explicit empty
    // string/null is a deliberate removal from Embed Builder.
    description: hasDescription ? data.description : undefined,
    ...(applyFields ? { fields } : {}),
    color: Number.isInteger(data.color) ? data.color : null,
    footer: data.footer?.text ? { ...data.footer } : null,
    applyThumbnail,
    thumbnail: applyThumbnail && data.thumbnail?.url ? { url: data.thumbnail.url } : null,
    applyImage,
    image: applyImage && data.image?.url ? { url: data.image.url } : null,
  };
}

function templateAliases(matchNames = [], embedData = {}) {
  return [
    ...matchNames,
    embedData.title,
    String(embedData.description || '').split('\n').find(Boolean),
  ]
    .flatMap(aliasKeys)
    .filter(Boolean);
}

function prepareTemplateUpdate(matchNames = [], embedData = {}, options = {}) {
  const updatedAt = new Date().toISOString();
  return {
    aliases: [...new Set(templateAliases(matchNames, embedData))],
    template: pickTemplate(embedData, options),
    updatedAt,
  };
}

function primeTemplateOverlay(key, prepared) {
  if (!prepared.aliases.length) return;
  const current = { ...(templateOverlays.get(key) || {}) };
  for (const alias of prepared.aliases) {
    current[alias] = { ...prepared.template, updatedAt: prepared.updatedAt };
  }
  templateOverlays.set(key, current);
}

function clearSavedTemplateOverlay(key, prepared) {
  const current = templateOverlays.get(key);
  if (!current) return;

  const next = { ...current };
  for (const alias of prepared.aliases) {
    if (next[alias]?.updatedAt === prepared.updatedAt) delete next[alias];
  }
  if (Object.keys(next).length) templateOverlays.set(key, next);
  else templateOverlays.delete(key);
}

async function saveTemplate(guildId, scope, matchNames = [], embedData = {}, options = {}) {
  const key = templateKey(guildId, scope);
  const prepared = prepareTemplateUpdate(matchNames, embedData, options);
  primeTemplateOverlay(key, prepared);

  try {
    return await mutateTemplates(guildId, scope, async () => {
      const stored = await loadTemplates(guildId, scope);
      const templates = { ...stored };

      for (const alias of prepared.aliases) {
        templates[alias] = {
          ...prepared.template,
          updatedAt: prepared.updatedAt,
        };
      }

      const saved = await setInDb(key, templates);
      if (!saved) {
        logger.error(`Failed to persist embed template for ${guildId}:${scope}`);
        clearSavedTemplateOverlay(key, prepared);
        return false;
      }

      templateCache.set(key, templates);
      clearSavedTemplateOverlay(key, prepared);
      return true;
    });
  } catch (error) {
    clearSavedTemplateOverlay(key, prepared);
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

function findStoredTemplate(data, stored, { strictTitle = false } = {}) {
  const candidates = [
    data.title,
    ...(strictTitle ? [] : [String(data.description || '').split('\n').find(Boolean)]),
  ]
    .flatMap(aliasKeys)
    .filter(Boolean);

  return candidates.map(candidate => stored[candidate]).find(Boolean) || null;
}

function decorateEmbedData(embed, stored, options = {}) {
  const original = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
  const data = { ...original };

  const template = findStoredTemplate(data, stored, options);
  if (!template) return { matched: false, changed: false, data };

  if (template.title) {
    data.title = renderDynamic(template.title, original.title || '', {
      fallbackToRuntimeOnMismatch: true,
    });
  } else {
    delete data.title;
  }

  if (template.applyDescription !== false && template.description !== undefined
      && (template.schemaVersion >= 3 || Boolean(template.description))) {
    if (template.description) {
      const description = renderDynamic(template.description, original.description || '', {
        fallbackToRuntimeOnMismatch: true,
      });
      if (description) data.description = description;
      else delete data.description;
    } else {
      delete data.description;
    }
  }

  if (template.applyFields !== false && Array.isArray(template.fields)
      && (template.schemaVersion >= 3 || template.fields.length)) {
    if (!template.fields.length) {
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
            preserveRuntimeWhenNoDynamic: !(template.schemaVersion >= 2),
          }).slice(0, 1024),
          inline: Boolean(templateField.inline),
        };
      });
    }
  }

  if (Number.isInteger(template.color)) data.color = template.color;

  if (template.applyFooter === false) {
    // Keep the current footer when Save changed another part of the embed.
  } else if (template.footer?.text) {
    data.footer = {
      ...template.footer,
      text: renderDynamic(template.footer.text, original.footer?.text || template.footer.text, {
        fallbackToRuntimeOnMismatch: true,
      }),
    };
  } else if (template.schemaVersion >= 3) {
    delete data.footer;
  }

  // User/member avatars and other event-specific thumbnails stay dynamic unless
  // the administrator explicitly changed/removed the thumbnail in Embed Builder.
  if (template.applyThumbnail === true) {
    if (template.thumbnail?.url) data.thumbnail = { url: template.thumbnail.url };
    else delete data.thumbnail;
  }

  const isOfficialRustPatch = /^https:\/\/rust\.facepunch\.com\/news\//i.test(String(original.url || ''));
  if (template.applyImage === true) {
    if (template.image?.url) data.image = { url: template.image.url };
    // The article hero is live patch data, just like a ticket number or user.
    // An older empty Builder media value may not erase that official banner.
    else if (!isOfficialRustPatch) delete data.image;
  }

  const finalData = stripBlackjackCardsRemaining(data);
  return {
    matched: true,
    changed: JSON.stringify(original) !== JSON.stringify(finalData),
    data: finalData,
  };
}

export async function decorateEmbedWithSavedTemplate(guildId, channelId, embed, options = {}) {
  try {
    const stored = await loadMergedTemplates(guildId, channelId);
    const result = decorateEmbedData(embed, stored, options);
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

export async function warmSavedEmbedTemplateScopes(guildId, channelIds = []) {
  await Promise.all([...new Set([GLOBAL_SCOPE, ...channelIds].filter(Boolean))]
    .map(channelId => loadTemplates(guildId, channelId)));
}

export function getCachedSavedEmbedTemplateData(guildId, channelId, embedData) {
  const globalKey = templateKey(guildId, GLOBAL_SCOPE);
  const channelKey = templateKey(guildId, channelId);
  // Look up only the title aliases. Copying every saved template for each
  // registry row made a Builder list unnecessarily quadratic.
  const scopes = [templateOverlays.get(channelKey), templateCache.get(channelKey),
    templateOverlays.get(globalKey), templateCache.get(globalKey)];
  const aliasesToFind = aliasKeys(embedData.title);
  let template = null;
  for (const scope of scopes) {
    template = aliasesToFind.map(alias => scope?.[alias]).find(Boolean);
    if (template) break;
  }
  if (!template) return { matched: false, data: embedData };
  const helperArtifact = /^(?:success|failed|error|warning|information)$/i.test(String(template.title || ''))
    && normalizeKey(template.description) === normalizeKey(embedData.title)
    && normalizeKey(template.title) !== normalizeKey(embedData.title);
  if (helperArtifact) return { matched: false, data: embedData };
  // Older title-only Saves stored empty fields/footer alongside an omitted
  // description. They are incomplete snapshots, not a request to erase live data.
  const sparse = template.description === undefined;
  const genericStatus = /^(?:success|failed|error|warning|information|invalid|expired|too fast|cooldown|on cooldown|please wait|slow down)$/i.test(String(embedData.title || '').trim());
  const decoration = { ...template };
  if ((sparse && !(template.schemaVersion >= 3)) || genericStatus) {
    delete decoration.description;
    delete decoration.fields;
    if (!decoration.footer) decoration.footer = embedData.footer || null;
  }
  if (!(template.schemaVersion >= 3) && Array.isArray(decoration.fields) && !decoration.fields.length) delete decoration.fields;
  const aliases = aliasKeys(embedData.title);
  const result = decorateEmbedData(embedData, Object.fromEntries(aliases.map(alias => [alias, decoration])), { strictTitle: true });
  return { ...result, updatedAt: template.updatedAt };
}

export async function applySavedEmbedTemplates(message, { initialCreation = false } = {}) {
  if (!message?.guildId || !message?.channelId || !message?.editable || !message?.embeds?.length) return false;

  // ZORP Guide is owner-authored content. Never rewrite it from background
  // template/catalog/normalization passes. A manual Embed Builder Save still
  // edits the message and persists its template through the normal save path.
  const isProtectedZorpGuide = message.embeds.some(embed => /^\s*(?:☑️\s*)?ZORP Guide\s*$/i.test(String(embed?.title || '')));
  if (isProtectedZorpGuide) return true;
  if (PRESERVE_EXISTING_EMBEDS && !initialCreation) return true;

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

    // A template that already matches is still authoritative. Reporting it as
    // unmatched lets the generic branding handler run afterward and reintroduce
    // default styling on a correctly saved game/log embed.
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
