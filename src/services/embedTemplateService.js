import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';
const GLOBAL_SCOPE = '__global__';
const SAVED_TEMPLATE_MARKER = Symbol.for('cloudy.savedEmbedTemplateApplied');
const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
const SYSTEM_TEMPLATE_KEY_PREFIX = 'Cloudy template key:';
const SYSTEM_TEMPLATE_CONTEXT_SEPARATOR = ' || Cloudy context:';
const SYSTEM_TEMPLATE_KIND_SEPARATOR = ' || Cloudy kind:';
const templateCache = new Map();
const templateMutationQueues = new Map();
const pendingTemplateOverlays = new Map();
let pendingTemplateRevision = 0;

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function templateKey(guildId, channelId) {
  return `${TEMPLATE_PREFIX}${guildId}:${channelId}`;
}

function cleanTemplates(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableSystemTemplateAlias(data = {}) {
  const authorName = String(data?.author?.name || '');
  if (!authorName.toLowerCase().startsWith(SYSTEM_TEMPLATE_KEY_PREFIX.toLowerCase())) return null;

  let metadata = authorName.slice(SYSTEM_TEMPLATE_KEY_PREFIX.length).trim();
  let context = 'global';
  let kind = 'embed';

  const kindIndex = metadata.toLowerCase().indexOf(SYSTEM_TEMPLATE_KIND_SEPARATOR.toLowerCase());
  if (kindIndex !== -1) {
    kind = normalizeKey(metadata.slice(kindIndex + SYSTEM_TEMPLATE_KIND_SEPARATOR.length)) || 'embed';
    metadata = metadata.slice(0, kindIndex);
  }

  const contextIndex = metadata.toLowerCase().indexOf(SYSTEM_TEMPLATE_CONTEXT_SEPARATOR.toLowerCase());
  if (contextIndex !== -1) {
    context = normalizeKey(metadata.slice(contextIndex + SYSTEM_TEMPLATE_CONTEXT_SEPARATOR.length)) || 'global';
    metadata = metadata.slice(0, contextIndex);
  }

  const key = normalizeKey(metadata);
  return key ? `__system__:${context}:${kind}:${key}` : null;
}

function markSavedTemplate(embed) {
  if (!embed || typeof embed !== 'object') return embed;
  Object.defineProperty(embed, SAVED_TEMPLATE_MARKER, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return embed;
}

function pendingTemplatesForKey(key) {
  const overlay = pendingTemplateOverlays.get(key);
  if (!overlay) return {};
  return Object.fromEntries([...overlay.entries()].map(([alias, entry]) => [alias, entry.template]));
}

async function loadTemplates(guildId, channelId) {
  const key = templateKey(guildId, channelId);
  if (templateCache.has(key)) return templateCache.get(key);
  const templates = cleanTemplates(await getFromDb(key, {}));
  templateCache.set(key, templates);
  return templates;
}

async function loadMergedTemplates(guildId, channelId) {
  const globalKey = templateKey(guildId, GLOBAL_SCOPE);
  const channelKey = templateKey(guildId, channelId);
  const [globalTemplates, channelTemplates] = await Promise.all([
    loadTemplates(guildId, GLOBAL_SCOPE),
    loadTemplates(guildId, channelId),
  ]);
  return {
    ...globalTemplates,
    ...pendingTemplatesForKey(globalKey),
    ...channelTemplates,
    ...pendingTemplatesForKey(channelKey),
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
  text = text.replace(
    /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|[$€£][\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b(?:red|black|green|even|odd|player|banker|tie)\b|\b\d+(?:\.\d+)?\b/gi,
    match => {
      values.push(match);
      return '{dynamic}';
    },
  );
  text = text.replaceAll(sentinel, '{dynamic}');
  return { pattern: normalizeKey(text), tokenized: text, values };
}

function dynamicSlotCount(value = '') {
  return (dynamicParts(value).tokenized.match(/\{dynamic\}/gi) || []).length;
}

function renderDynamic(template, runtime, { appendMissingRuntimeDynamics = false } = {}) {
  const source = String(runtime || '');
  const templateSource = String(template || '');
  const runtimeParts = dynamicParts(source);
  const templateParts = dynamicParts(templateSource);
  const placeholders = templateParts.tokenized.match(/\{dynamic\}/gi) || [];

  if (!placeholders.length) {
    if (appendMissingRuntimeDynamics && runtimeParts.values.length) {
      const cleanTemplate = templateSource.replace(/\u200B/g, '').trim();
      if (!cleanTemplate) return source;
      return `${cleanTemplate} ${runtimeParts.values.join(' ')}`.trim();
    }
    return templateSource;
  }

  if (runtimeParts.values.length !== placeholders.length) return source || templateSource;

  let runtimeIndex = 0;
  let fallbackIndex = 0;
  return templateParts.tokenized.replace(/\{dynamic\}/gi, () => {
    const runtimeValue = runtimeParts.values[runtimeIndex++];
    const savedFallback = templateParts.values[fallbackIndex++];
    return runtimeValue ?? savedFallback ?? '';
  });
}

function splitLabeledDynamicLine(line) {
  const match = String(line || '').match(/^(\s*(?:>\s*)?\*\*[^*]+:\*\*\s*)(.*)$/);
  return match ? { prefix: match[1], value: match[2] } : null;
}

function mergeRuntimeDescription(template, runtime) {
  const templateLines = String(template || '').split('\n');
  const runtimeLines = String(runtime || '').split('\n');
  const lineCount = Math.max(templateLines.length, runtimeLines.length);
  const merged = [];

  for (let index = 0; index < lineCount; index += 1) {
    const templateLine = templateLines[index] ?? '';
    const runtimeLine = runtimeLines[index] ?? '';
    const templateLabeled = splitLabeledDynamicLine(templateLine);
    const runtimeLabeled = splitLabeledDynamicLine(runtimeLine);

    if (templateLabeled && runtimeLabeled) {
      merged.push(`${templateLabeled.prefix}${runtimeLabeled.value}`);
      continue;
    }

    if (!templateLine && runtimeLine) {
      merged.push(runtimeLine);
      continue;
    }

    merged.push(renderDynamic(templateLine, runtimeLine, { appendMissingRuntimeDynamics: true }));
  }

  return merged.join('\n').slice(0, 4096);
}

function mergeRuntimeFieldValue(templateValue, runtimeValue) {
  const runtime = String(runtimeValue || '');
  const template = String(templateValue || '');
  if (!runtime) return template;
  if (!template || !template.replace(/\u200B/g, '').trim()) return runtime;
  if (dynamicSlotCount(template) > 0) return renderDynamic(template, runtime);

  // Field values carry game/log state (bet, hand value, balance, moderator,
  // reason, IDs, timestamps, etc.). Keep the live runtime value authoritative
  // unless the template explicitly contains dynamic placeholders.
  return runtime;
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
  const applyThumbnail = options.applyThumbnail === true || data.thumbnail?.url === CLOUDY_LOGO_URL;
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

function preserveMissingTitleDynamics(template, matchNames = []) {
  if (!template?.applyTitle || !template.title || dynamicSlotCount(template.title) > 0) return template;
  const sourceSlots = matchNames.map(dynamicSlotCount).find(count => count > 0) || 0;
  if (!sourceSlots) return template;
  const placeholders = Array.from({ length: sourceSlots }, () => '{dynamic}').join(' ');
  return { ...template, title: `${String(template.title).trim()} ${placeholders}`.trim().slice(0, 256) };
}

function buildTemplate(embedData = {}, options = {}, matchNames = []) {
  return preserveMissingTitleDynamics(pickTemplate(embedData, options), matchNames);
}

function templateAliases(matchNames = [], embedData = {}) {
  const stableAlias = stableSystemTemplateAlias(embedData);
  const legacyAliases = [
    ...matchNames,
    embedData.title,
    String(embedData.description || '').split('\n').find(Boolean),
  ].flatMap(aliasKeys).filter(Boolean);
  return [...new Set([stableAlias, ...legacyAliases].filter(Boolean))];
}

function stageTemplate(guildId, scope, matchNames = [], embedData = {}, options = {}) {
  const key = templateKey(guildId, scope);
  const revision = ++pendingTemplateRevision;
  const template = { ...buildTemplate(embedData, options, matchNames), updatedAt: new Date().toISOString() };
  const aliases = templateAliases(matchNames, embedData);
  const overlay = pendingTemplateOverlays.get(key) || new Map();
  for (const alias of aliases) overlay.set(alias, { revision, template });
  pendingTemplateOverlays.set(key, overlay);
  return { key, revision, aliases, template };
}

function clearStagedTemplate(stage) {
  if (!stage) return;
  const overlay = pendingTemplateOverlays.get(stage.key);
  if (!overlay) return;
  for (const alias of stage.aliases) {
    if (overlay.get(alias)?.revision === stage.revision) overlay.delete(alias);
  }
  if (!overlay.size) pendingTemplateOverlays.delete(stage.key);
}

async function saveTemplate(guildId, scope, matchNames = [], embedData = {}, options = {}, stage = null) {
  try {
    return await mutateTemplates(guildId, scope, async () => {
      const key = templateKey(guildId, scope);
      const stored = await loadTemplates(guildId, scope);
      const templates = { ...stored };
      const template = stage?.template || { ...buildTemplate(embedData, options, matchNames), updatedAt: new Date().toISOString() };
      const aliases = stage?.aliases || templateAliases(matchNames, embedData);
      for (const alias of aliases) templates[alias] = template;

      const saved = await setInDb(key, templates);
      if (!saved) {
        clearStagedTemplate(stage);
        logger.error(`Failed to persist embed template for ${guildId}:${scope}`);
        return false;
      }
      templateCache.set(key, templates);
      clearStagedTemplate(stage);
      return true;
    });
  } catch (error) {
    clearStagedTemplate(stage);
    logger.error('Failed to save embed template:', error);
    return false;
  }
}

function beginSaveTemplate(guildId, scope, matchNames = [], embedData = {}, options = {}) {
  const stage = stageTemplate(guildId, scope, matchNames, embedData, options);
  return saveTemplate(guildId, scope, matchNames, embedData, options, stage);
}

export function saveEmbedTemplateDecoration(guildId, channelId, matchNames = [], embedData = {}, options = {}) {
  return beginSaveTemplate(guildId, channelId, matchNames, embedData, options);
}

export function saveGlobalEmbedTemplate(guildId, matchNames = [], embedData = {}, options = {}) {
  return beginSaveTemplate(guildId, GLOBAL_SCOPE, matchNames, embedData, options);
}

function findStoredTemplate(data, stored) {
  const stableAlias = stableSystemTemplateAlias(data);
  if (stableAlias && stored[stableAlias]) return stored[stableAlias];

  const candidates = [data.title, String(data.description || '').split('\n').find(Boolean)]
    .flatMap(aliasKeys)
    .filter(Boolean);
  return candidates.map(candidate => stored[candidate]).find(Boolean) || null;
}

function shouldApply(template, flagName, valueName) {
  if (template?.[flagName] === true) return true;
  if (template?.[flagName] === false) return false;
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
      data.title = renderDynamic(template.title, original.title || '', { appendMissingRuntimeDynamics: true }).slice(0, 256);
    } else delete data.title;
  }

  if (shouldApply(template, 'applyDescription', 'description')) {
    if (template.description) data.description = mergeRuntimeDescription(template.description, original.description || '');
    else if (dynamicParts(original.description || '').values.length) data.description = original.description;
    else delete data.description;
  }

  if (shouldApply(template, 'applyFields', 'fields')) {
    const runtimeFields = Array.isArray(original.fields) ? original.fields : [];
    if (runtimeFields.length) {
      data.fields = runtimeFields.slice(0, 25).map((runtimeField, index) => {
        const templateField = template.fields?.[index];
        if (!templateField) return { ...runtimeField };
        return {
          name: templateField.name
            ? (/\{dynamic\}/i.test(templateField.name)
                ? renderDynamic(templateField.name, runtimeField.name || templateField.name)
                : templateField.name
              ).slice(0, 256)
            : String(runtimeField.name || '\u200B').slice(0, 256),
          value: mergeRuntimeFieldValue(templateField.value, runtimeField.value).slice(0, 1024),
          inline: typeof templateField.inline === 'boolean' ? templateField.inline : Boolean(runtimeField.inline),
        };
      });
    } else if (template.fields?.length) {
      data.fields = template.fields.slice(0, 25).map(field => ({ ...field }));
    } else {
      delete data.fields;
    }
  }

  if (Number.isInteger(template.color)) data.color = template.color;

  if (shouldApply(template, 'applyFooter', 'footer')) {
    if (template.footer?.text) {
      data.footer = {
        ...template.footer,
        text: renderDynamic(template.footer.text, original.footer?.text || template.footer.text, { appendMissingRuntimeDynamics: true }),
      };
    } else delete data.footer;
  }

  if (template.applyThumbnail === true) {
    if (template.thumbnail?.url) data.thumbnail = { url: template.thumbnail.url };
    else delete data.thumbnail;
  }

  if (template.applyImage === true) {
    if (template.image?.url) data.image = { url: template.image.url };
    else delete data.image;
  }

  return { matched: true, changed: JSON.stringify(original) !== JSON.stringify(data), data };
}

export async function decorateEmbedWithSavedTemplate(guildId, channelId, embed) {
  try {
    if (embed?.[SAVED_TEMPLATE_MARKER]) return { matched: true, changed: false, embed };
    const stored = await loadMergedTemplates(guildId, channelId);
    const result = decorateEmbedData(embed, stored);
    return {
      matched: result.matched,
      changed: result.changed,
      embed: result.matched ? markSavedTemplate(new EmbedBuilder(result.data)) : embed,
    };
  } catch (error) {
    logger.error('Failed to decorate embed with saved template:', error);
    return { matched: false, changed: false, embed };
  }
}

export async function decoratePayloadWithSavedTemplates(guildId, channelId, payload) {
  if (!guildId || !channelId || !payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  const embeds = await Promise.all(payload.embeds.map(async embed => (await decorateEmbedWithSavedTemplate(guildId, channelId, embed)).embed));
  return { ...payload, embeds };
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
      return markSavedTemplate(new EmbedBuilder(result.data));
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
