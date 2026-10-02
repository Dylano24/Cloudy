import fs from 'node:fs';

function replaceOnce(text, find, replace, label) {
  if (!text.includes(find)) throw new Error(`[RESPONSE_EMBED_SOURCE_ALIAS] marker not found: ${label}`);
  return text.replace(find, replace);
}

{
  const path = 'src/services/systemEmbedCatalogService.js';
  const before = fs.readFileSync(path, 'utf8');
  if (before.includes('RESPONSE_EMBED_SOURCE_ALIAS_V1')) {
    console.log('[RESPONSE_EMBED_SOURCE_ALIAS] system catalog already current');
  } else {
    let text = before;

    text = replaceOnce(
      text,
      'const plainSourceAliases = new Map();',
      `const plainSourceAliases = new Map();
const embedSourceAliases = new Map();
// RESPONSE_EMBED_SOURCE_ALIAS_V1: source-discovered embed titles retain one runtime identity.`,
      'alias map',
    );

    const helperMarker = `function plainManagementHint(content = '') {`;
    const helper = `
function embedSourceAliasIdentity(context, title) {
  return cacheIdentity(\`source-title:\${normalize(title)}\`, context);
}

function registerEmbedSourceAlias(definition, entry = null) {
  if (normalize(definition?.kind) !== 'embed') return false;
  const title = String(definition.title || '').trim();
  const normalized = entry || definitionToCatalog(normalizeDiscoveredDefinition(definition));
  if (!title || !normalized?.key || !normalized?.context) return false;

  const identity = embedSourceAliasIdentity(normalized.context, title);
  const current = embedSourceAliases.get(identity);
  if (current && current !== normalized.key) {
    embedSourceAliases.set(identity, '');
    return false;
  }
  if (!current) embedSourceAliases.set(identity, normalized.key);
  return true;
}

function resolveEmbedSourceAlias(context, title) {
  const key = embedSourceAliases.get(embedSourceAliasIdentity(context, title));
  return typeof key === 'string' && key ? key : null;
}

`;
    text = replaceOnce(text, helperMarker, helper + helperMarker, 'alias helpers');

    text = replaceOnce(
      text,
      `  registerPlainSourceAlias(normalizedDefinition, entry);
  if (!entry.key || isInternalTemplate(entry.data) || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;`,
      `  registerPlainSourceAlias(normalizedDefinition, entry);
  registerEmbedSourceAlias(normalizedDefinition, entry);
  if (!entry.key || isInternalTemplate(entry.data) || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;`,
      'discovered definition alias',
    );

    text = replaceOnce(
      text,
      `  const key = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  if (!key || !isEditableSystemCatalogTemplate(key, context)) return false;`,
      `  const key = resolveEmbedSourceAlias(context, data.title)
    || getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  if (!key || !isEditableSystemCatalogTemplate(key, context)) return false;`,
      'runtime capture alias',
    );

    text = replaceOnce(
      text,
      `  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  const titleKey = normalize(data.title);`,
      `  const specificKey = resolveEmbedSourceAlias(context, data.title)
    || getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  const titleKey = normalize(data.title);`,
      'runtime lookup alias',
    );

    text = replaceOnce(
      text,
      `  plainSourceAliases.clear();`,
      `  plainSourceAliases.clear();
  embedSourceAliases.clear();
  for (const definition of discoveredDefinitions) {
    if (normalize(definition.kind) !== 'embed') continue;
    const entry = definitionToCatalog(definition);
    registerEmbedSourceAlias(definition, entry);
  }`,
      'catalog alias initialization',
    );

    fs.writeFileSync(path, text, 'utf8');
    console.log('[RESPONSE_EMBED_SOURCE_ALIAS] patched source embed aliases');
  }
}

{
  const path = 'src/services/embedManagerService.js';
  const before = fs.readFileSync(path, 'utf8');
  if (before.includes('RESPONSE_EMBED_SOURCE_ALIAS_PREVIEW_V1')) {
    console.log('[RESPONSE_EMBED_SOURCE_ALIAS] preview already current');
  } else {
    let text = before;
    const oldFn = `export function prefersCatalogPreview(records) {
    const catalogRecords = records.filter(record => String(record?.source || '') === 'system-catalog');
    if (catalogRecords.length > 1) return true;

    return catalogRecords.some(record => {
        const context = stableSystemTemplateContext(getEmbedRegistrySnapshot(record));
        return /^(?:gambling|tickets)(?:\\/|$)/.test(context);
    });
}`;
    const newFn = `export function prefersCatalogPreview(records) {
    // RESPONSE_EMBED_SOURCE_ALIAS_PREVIEW_V1
    // A real Discord response is the most complete preview. The hidden catalog
    // remains the reusable Save source, but it must not replace a full live
    // response with a sparse title-only card when both are available.
    const realRecords = records.filter(record => String(record?.source || '') !== 'system-catalog');
    if (realRecords.length) return false;

    const catalogRecords = records.filter(record => String(record?.source || '') === 'system-catalog');
    if (catalogRecords.length > 1) return true;

    return catalogRecords.some(record => {
        const context = stableSystemTemplateContext(getEmbedRegistrySnapshot(record));
        return /^(?:gambling|tickets)(?:\\/|$)/.test(context);
    });
}`;
    text = replaceOnce(text, oldFn, newFn, 'full live preview preference');

    text = replaceOnce(
      text,
      '    if (stableKey) return stableKey;',
      `    // Generic embed hashes are historical storage identities, not separate
    // visible Builder types. Let their normalized title shape group old and
    // current copies together. Named and game keys remain authoritative.
    if (stableKey && !stableKey.startsWith('embed:')) return stableKey;`,
      'generic source display identity',
    );

    const representativeOld = `        const canonicalCatalogRecords = group.canonicalCasinoKey
            ? group.records.filter(record => stableSystemTemplateKey(recordEmbedData(record)) === group.canonicalCasinoKey)
            : [];
        const representative = canonicalCatalogRecords.at(-1)
            || (realRecords.length ? realRecords : group.records).at(-1);`;
    const representativeNew = `        const canonicalCatalogRecords = group.canonicalCasinoKey
            ? group.records.filter(record => stableSystemTemplateKey(recordEmbedData(record)) === group.canonicalCasinoKey)
            : [];
        const sourceCatalogRecords = group.canonicalCasinoKey
            ? []
            : group.records.filter(record =>
                record.source === 'system-catalog'
                && stableSystemTemplateKey(recordEmbedData(record)).startsWith('embed:')
            );
        // Keep one canonical hidden catalog record as the Save target for a
        // source-defined response. Real messages still provide the first live
        // channel preview, but duplicate catalog hashes no longer become
        // separate options.
        const representative = canonicalCatalogRecords.at(-1)
            || sourceCatalogRecords[0]
            || (realRecords.length ? realRecords : group.records).at(-1);`;
    text = replaceOnce(text, representativeOld, representativeNew, 'canonical generic source Save target');

    fs.writeFileSync(path, text, 'utf8');
    console.log('[RESPONSE_EMBED_SOURCE_ALIAS] patched full live preview and duplicate grouping');
  }
}
