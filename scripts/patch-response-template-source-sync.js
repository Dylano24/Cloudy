import fs from 'node:fs';

const path = 'src/services/systemEmbedCatalogService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const marker = 'SOURCE_RESPONSE_SYNC_V1';
if (text.includes(marker)) {
  console.log('[SOURCE_RESPONSE_SYNC] already current');
  process.exit(0);
}

function replaceOnce(find, replace, label) {
  if (!text.includes(find)) {
    console.error(`[SOURCE_RESPONSE_SYNC] marker not found (${label})`);
    process.exit(1);
  }
  text = text.replace(find, replace);
}

replaceOnce(
  'const pendingTemplates = new Map();\nlet flushTimer = null;',
  `const pendingTemplates = new Map();
const plainSourceAliases = new Map();
const SOURCE_BASELINE_PREFIX = 'cloudy:system-embed-source-baseline:';
// SOURCE_RESPONSE_SYNC_V1: source-discovered plain responses have durable identities.
let flushTimer = null;
let catalogEnsurePromise = null;`,
  'state constants',
);

replaceOnce(
  `function dynamicParts(value = '') {`,
  `function sourceBaselineStorageKey(guildId) {
  return \`\${SOURCE_BASELINE_PREFIX}\${guildId}\`;
}

function sourceDefinitionKey(definition = {}) {
  const variantId = String(definition.variantId || '').trim();
  if (normalize(definition.kind) !== 'content' || !variantId) return null;
  return \`source:\${shortHash(variantId)}\`;
}

function normalizeDiscoveredDefinition(definition = {}) {
  const key = sourceDefinitionKey(definition);
  return key ? { ...definition, key } : definition;
}

function plainSourceAliasIdentity(context, content) {
  return cacheIdentity(responseSignature('content', '', content), context);
}

function registerPlainSourceAlias(definition, entry = null) {
  if (normalize(definition?.kind) !== 'content') return false;
  const normalized = entry || definitionToCatalog(normalizeDiscoveredDefinition(definition));
  if (!normalized?.key || !normalized?.context) return false;
  const content = definition.description || definition.content || '';
  if (!String(content).trim()) return false;
  plainSourceAliases.set(plainSourceAliasIdentity(normalized.context, content), normalized.key);
  return true;
}

function plainManagementHint(content = '') {
  const value = String(content || '').replace(/<a?:[^:>]+:\\d+>/g, '').replace(/\\{dynamic\\}/gi, '').replace(/\\s+/g, ' ').trim();
  const rules = [
    [/choose one of the (?:staff members|owners) first.*select your rating/i, 'Select staff first'],
    [/that member is no longer available for staff reviews/i, 'Member unavailable'],
    [/review selectors could not be updated/i, 'Selector update failed'],
    [/review session expired/i, 'Session expired'],
    [/community reviews channel .*unavailable/i, 'Reviews channel unavailable'],
    [/staff review could not be published/i, 'Publish failed'],
    [/staff review has been published/i, 'Review published'],
    [/wrong channel/i, 'Wrong channel'],
    [/permission denied|access denied/i, 'Permission denied'],
    [/could not|failed|failure|error/i, 'Error'],
    [/expired/i, 'Expired'],
    [/saved|updated/i, 'Saved'],
    [/success|completed|done/i, 'Success'],
  ];
  const explicit = rules.find(([pattern]) => pattern.test(value));
  if (explicit) return explicit[1];
  return (value.split(/[.!?]/)[0].split(/\\s+/).filter(Boolean).slice(0, 5).join(' ') || 'Message').slice(0, 48);
}

function dynamicParts(value = '') {`,
  'source identity helpers',
);

replaceOnce(
  `function friendlyPlainTitle(context, content) {
  const command = normalize(context).split('/')[1] || normalize(context).split('/')[0] || 'bot';
  const prefix = command ? command.charAt(0).toUpperCase() + command.slice(1) : 'Bot';
  const preview = String(content || '')
    .replace(/<a?:[^:>]+:\\d+>/g, '')
    .replace(/\\{dynamic\\}/gi, '…')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 65);
  return \`\${prefix} • \${preview || 'Message'}\`.slice(0, 256);
}`,
  `function friendlyPlainTitle(context, content) {
  const command = normalize(context).split('/')[1] || normalize(context).split('/')[0] || 'bot';
  const prefix = command
    ? command.split(/[-_]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
    : 'Bot';
  return \`\${prefix} • \${plainManagementHint(content)}\`.slice(0, 256);
}`,
  'plain management title',
);

replaceOnce(
  `function findCatalogEntry(messages, entry) {
  const identity = entryIdentity(entry);
  for (const message of messages) {
    for (let index = 0; index < (message?.embeds?.length || 0); index += 1) {
      const metadata = parseTemplateMetadata(message.embeds[index]);
      if (
        cacheIdentity(metadata.key, metadata.context) === identity
        || catalogEntryIdentity(metadata, message.embeds[index]) === identity
      ) {
        return { message, index, embed: message.embeds[index], metadata };
      }
    }
  }
  return null;
}

async function appendCatalogEntry`,
  `function findCatalogEntry(messages, entry) {
  const identity = entryIdentity(entry);
  for (const message of messages) {
    for (let index = 0; index < (message?.embeds?.length || 0); index += 1) {
      const metadata = parseTemplateMetadata(message.embeds[index]);
      if (
        cacheIdentity(metadata.key, metadata.context) === identity
        || catalogEntryIdentity(metadata, message.embeds[index]) === identity
      ) {
        return { message, index, embed: message.embeds[index], metadata };
      }
    }
  }
  return null;
}

function jsonEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function copySourceField(next, current, previous, incoming, field) {
  if (!jsonEqual(current?.[field], previous?.[field])) return;
  if (Object.prototype.hasOwnProperty.call(incoming || {}, field)) next[field] = structuredClone(incoming[field]);
  else delete next[field];
}

function mergeSourceDefinitionData(currentData, previousSourceData, incomingSourceData, entry) {
  const current = cloneData(currentData || {});
  const previous = cloneData(previousSourceData || {});
  const incoming = cloneData(incomingSourceData || {});
  const next = { ...current };

  for (const field of ['title', 'description', 'color', 'fields', 'footer', 'thumbnail', 'image']) {
    copySourceField(next, current, previous, incoming, field);
  }

  // Stable metadata is internal identity, not administrator-authored presentation.
  return withStableKey(next, entry.key, entry.context, entry.kind);
}

function normalizedWords(value = '') {
  return new Set(normalize(value).replace(/[^a-z0-9\\s]/g, ' ').split(/\\s+/).filter(word => word.length > 1));
}

function textSimilarity(left, right) {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function isGeneratedLegacyPlainTitle(data = {}) {
  const title = normalize(data.title);
  const description = normalize(data.description);
  if (!title || !description || !title.includes(' • ')) return false;
  const suffix = title.split(' • ').slice(1).join(' • ');
  return description.startsWith(suffix) || suffix.startsWith(description.slice(0, Math.min(40, description.length)));
}

function findLegacyPlainSourceCandidate(messages, entry, claimed = new Set()) {
  const base = normalize(entry.data?.title).split(' • ')[0];
  let winner = null;
  let bestScore = 0;

  for (const message of messages) {
    for (let index = 0; index < (message?.embeds?.length || 0); index += 1) {
      const claimKey = \`\${message.id}:\${index}\`;
      if (claimed.has(claimKey)) continue;
      const embed = message.embeds[index];
      const metadata = parseTemplateMetadata(embed);
      if (metadata.kind !== 'content' || normalize(metadata.context) !== normalize(entry.context)) continue;
      if (String(metadata.key || '').startsWith('source:')) continue;

      const data = cloneData(embed);
      if (!isGeneratedLegacyPlainTitle(data)) continue;
      const candidateBase = normalize(data.title).split(' • ')[0];
      const score = textSimilarity(data.description, entry.data?.description)
        + (base && candidateBase === base ? 0.35 : 0);
      if (score > bestScore) {
        bestScore = score;
        winner = { message, index, embed, metadata, claimKey };
      }
    }
  }

  return bestScore >= 0.62 ? winner : null;
}

async function editCatalogLocation(location, data) {
  const embeds = location.message.embeds.map(embed => new EmbedBuilder(embed.toJSON()));
  embeds[location.index] = new EmbedBuilder(data);
  return location.message.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
}

async function syncSourceDefinitionEntries(context, messages, sourceDefinitions = []) {
  if (!sourceDefinitions.length) return 0;
  const baselineKey = sourceBaselineStorageKey(context.guild.id);
  const previousBaseline = await getFromDb(baselineKey, {});
  const nextBaseline = {};
  const claimedLegacy = new Set();
  let changedCount = 0;

  for (const definition of sourceDefinitions) {
    const normalizedDefinition = normalizeDiscoveredDefinition(definition);
    const entry = definitionToCatalog(normalizedDefinition);
    if (!entry.key || !String(entry.key).startsWith('source:')) continue;
    registerPlainSourceAlias(normalizedDefinition, entry);

    let location = findCatalogEntry(messages, entry);
    let migratedLegacy = false;
    if (!location) {
      location = findLegacyPlainSourceCandidate(messages, entry, claimedLegacy);
      migratedLegacy = Boolean(location);
      if (location?.claimKey) claimedLegacy.add(location.claimKey);
    }

    if (!location) {
      if (await appendCatalogEntry(context, entry, messages)) changedCount += 1;
      nextBaseline[entry.key] = { variantId: normalizedDefinition.variantId, data: cloneData(entry.data) };
      continue;
    }

    const current = cloneData(location.embed);
    const previousSource = previousBaseline?.[entry.key]?.data || null;
    let next = current;

    if (previousSource) {
      next = mergeSourceDefinitionData(current, previousSource, entry.data, entry);
    } else if (migratedLegacy && isGeneratedLegacyPlainTitle(current)) {
      // Bootstrap old response-signature catalogs into stable source identities.
      // Only auto-generated title/body values are replaced; Builder styling survives.
      next = withStableKey({
        ...current,
        title: entry.data.title,
        description: entry.data.description,
      }, entry.key, entry.context, entry.kind);
    } else {
      next = withStableKey(current, entry.key, entry.context, entry.kind);
    }

    if (!catalogDataChanged(current, next)) {
      catalogEntries.add(cacheIdentity(entry.key, entry.context));
      rememberTemplate(entry.key, current, entry.context);
    } else {
      const edited = await editCatalogLocation(location, next);
      if (edited) {
        changedCount += 1;
        location.message = edited;
        location.embed = edited.embeds?.[location.index] || new EmbedBuilder(next);
        catalogEntries.add(cacheIdentity(entry.key, entry.context));
        rememberTemplate(entry.key, next, entry.context);
        await registerCatalogMessages([edited]).catch(error => logger.warn(\`Failed to register migrated source response: \${error.message}\`));
      }
    }

    nextBaseline[entry.key] = { variantId: normalizedDefinition.variantId, data: cloneData(entry.data) };
  }

  await setInDb(baselineKey, nextBaseline);
  return changedCount;
}

async function appendCatalogEntry`,
  'source synchronization engine',
);

replaceOnce(
  `export function registerDiscoveredEmbedDefinition(definition = {}) {
  const entry = definitionToCatalog(definition);
  if (!entry.key || isInternalTemplate(entry.data) || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;
  return queueRuntimeEntry(entry);
}`,
  `export function registerDiscoveredEmbedDefinition(definition = {}) {
  const normalizedDefinition = normalizeDiscoveredDefinition(definition);
  const entry = definitionToCatalog(normalizedDefinition);
  registerPlainSourceAlias(normalizedDefinition, entry);
  if (!entry.key || isInternalTemplate(entry.data) || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;
  return queueRuntimeEntry(entry);
}`,
  'discovered definition registration',
);

replaceOnce(
  `  const key = responseSignature('content', '', content);
  const template = findTemplate(key, context);

  if (!template) {
    const entry = definitionToCatalog({ kind: 'content', context, content, key });
    queueRuntimeEntry(entry);
    return payload;
  }`,
  `  const signature = responseSignature('content', '', content);
  const stableKey = plainSourceAliases.get(plainSourceAliasIdentity(context, content)) || null;
  const key = stableKey || signature;
  const template = findTemplate(key, context) || (stableKey ? findTemplate(signature, context) : null);

  if (!template) {
    const entry = definitionToCatalog({ kind: 'content', context, content, key });
    queueRuntimeEntry(entry);
    return payload;
  }`,
  'plain runtime lookup',
);

replaceOnce(
  `export async function ensureSystemEmbedCatalogs(client) {
  const discoveredDefinitions = await discoverStaticTemplates();`,
  `async function buildSystemEmbedCatalogs(client) {
  const discoveredDefinitions = (await discoverStaticTemplates()).map(normalizeDiscoveredDefinition);
  plainSourceAliases.clear();`,
  'normalize discovered definitions and isolate catalog build',
);

replaceOnce(
  `    for (const message of messages) rememberCatalogMessage(message);

    const entries = [`,
  `    for (const message of messages) rememberCatalogMessage(message);

    const sourceDefinitions = definitions.filter(definition => normalize(definition.kind) === 'content');
    totalAdded += await syncSourceDefinitionEntries(context, messages, sourceDefinitions);

    const entries = [`,
  'sync source entries before catalog append',
);

replaceOnce(
  `      ...definitions.map(definitionToCatalog),`,
  `      ...definitions.filter(definition => normalize(definition.kind) !== 'content').map(definitionToCatalog),`,
  'avoid duplicate source append',
);

replaceOnce(
  `  return { definitions: definitions.length, added: totalAdded };
}

export function primeSystemEmbedCatalogMessage(message) {`,
  `  return { definitions: definitions.length, added: totalAdded };
}

export function ensureSystemEmbedCatalogs(client) {
  // Catalog discovery is startup initialization. Runtime captures are handled by
  // flushPendingTemplates(), so re-running the full static scan only duplicates
  // Discord/DB work. Reuse the successful initialization for this process while
  // still allowing a clean retry if initialization itself fails.
  if (catalogEnsurePromise) return catalogEnsurePromise;

  catalogEnsurePromise = buildSystemEmbedCatalogs(client).catch(error => {
    catalogEnsurePromise = null;
    throw error;
  });
  return catalogEnsurePromise;
}

export function primeSystemEmbedCatalogMessage(message) {`,
  'single catalog initialization per process',
);

if (!text.includes(marker)) {
  console.error('[SOURCE_RESPONSE_SYNC] final marker missing');
  process.exit(1);
}

fs.writeFileSync(path, text, 'utf8');
console.log('[SOURCE_RESPONSE_SYNC] patched stable source identities + three-way source/Builder synchronization');
