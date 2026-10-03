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
const embedLegacyKeyAliases = new Map();
// RESPONSE_EMBED_SOURCE_ALIAS_V1: source-discovered embed titles retain one runtime identity.`,
      'alias map',
    );

    const helperMarker = `function plainManagementHint(content = '') {`;
    const helper = `
function embedSourceAliasIdentity(context, title) {
  return cacheIdentity(\`source-title:\${normalize(title)}\`, context);
}

function embedLegacyKeyAliasIdentity(context, key) {
  return cacheIdentity('legacy-key:' + normalize(key), context);
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
  } else if (!current) {
    embedSourceAliases.set(identity, normalized.key);
  }

  // Before canonical response-type keys existed, generic catalog rows were
  // keyed by title + description. Keep a durable alias from that old metadata
  // key to the one source response type. This still works after an admin edits
  // the visible title/body because the catalog author metadata keeps the old key.
  const legacyKey = responseSignature(
    'embed',
    definition.title || '',
    definition.description || definition.content || '',
  );
  const legacyIdentity = embedLegacyKeyAliasIdentity(normalized.context, legacyKey);
  const legacyCurrent = embedLegacyKeyAliases.get(legacyIdentity);
  if (legacyCurrent && legacyCurrent !== normalized.key) {
    embedLegacyKeyAliases.set(legacyIdentity, '');
  } else if (!legacyCurrent) {
    embedLegacyKeyAliases.set(legacyIdentity, normalized.key);
  }
  return true;
}

function resolveEmbedSourceAlias(context, title) {
  const key = embedSourceAliases.get(embedSourceAliasIdentity(context, title));
  return typeof key === 'string' && key ? key : null;
}

function resolveEmbedLegacyKeyAlias(context, key) {
  const alias = embedLegacyKeyAliases.get(embedLegacyKeyAliasIdentity(context, key));
  return typeof alias === 'string' && alias ? alias : null;
}

`;
    text = replaceOnce(text, helperMarker, helper + helperMarker, 'alias helpers');

    text = replaceOnce(
      text,
      `function semanticCatalogKey(metadata, embed) {
  if (String(metadata.key || '').startsWith('game:')
    && isEditableSystemCatalogTemplate(metadata.key, metadata.context)) return metadata.key;
  const data = cloneData(embed);

  // A legacy generic key that no longer matches its visible payload is an
  // administrator-edited template. Keep that stable identity instead of
  // treating the custom title as a brand-new response type.
  if (String(metadata.key || '').startsWith('embed:') && isLegacyCatalogEdit(metadata, data)) {
    return metadata.key;
  }

  const canonical = getSystemEmbedTemplateKey(
    metadata.kind,
    data.title,
    data.description,
    metadata.context,
  );
  return canonical && isEditableSystemCatalogTemplate(canonical, metadata.context)
    ? canonical
    : metadata.key;
}`,
      `function semanticCatalogKey(metadata, embed) {
  if (String(metadata.key || '').startsWith('game:')
    && isEditableSystemCatalogTemplate(metadata.key, metadata.context)) return metadata.key;

  const legacyAlias = resolveEmbedLegacyKeyAlias(metadata.context, metadata.key);
  if (legacyAlias) return legacyAlias;

  const data = cloneData(embed);

  // If an old generic row is not a known source definition and its visible
  // payload was manually edited, preserve that independent administrator
  // identity rather than guessing.
  if (String(metadata.key || '').startsWith('embed:') && isLegacyCatalogEdit(metadata, data)) {
    return metadata.key;
  }

  const canonical = getSystemEmbedTemplateKey(
    metadata.kind,
    data.title,
    data.description,
    metadata.context,
  );
  return canonical && isEditableSystemCatalogTemplate(canonical, metadata.context)
    ? canonical
    : metadata.key;
}`,
      'legacy generic catalog alias',
    );

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
  embedLegacyKeyAliases.clear();
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

    if (text.includes('    if (stableKey) return stableKey;')) {
      text = text.replace(
        '    if (stableKey) return stableKey;',
        `    // Generic embed/source hashes are historical storage identities, not separate
    // visible Builder types. Named/game/ticket keys remain authoritative.
    if (stableKey && !/^(?:embed(?:-type)?|source):/i.test(stableKey)) return stableKey;`,
      );
    } else if (!text.includes("if (stableKey && !/^(?:embed(?:-type)?|source):/i.test(stableKey)) return stableKey;")) {
      throw new Error('[RESPONSE_EMBED_SOURCE_ALIAS] generic source display identity marker not found');
    }

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
                && /^(?:embed|embed-type):/i.test(stableSystemTemplateKey(recordEmbedData(record)))
            );
        // The hidden catalog master is the Save target for a reusable response
        // type. A real runtime message is preview data only. This prevents
        // slash-command/interactions from failing Save and guarantees one Save
        // changes the reusable template for every future matching response.
        const representative = canonicalCatalogRecords.at(-1)
            || sourceCatalogRecords.at(-1)
            || (realRecords.length ? realRecords.at(-1) : null)
            || group.records.at(-1);`;
    text = replaceOnce(text, representativeOld, representativeNew, 'canonical generic source Save target');

    fs.writeFileSync(path, text, 'utf8');
    console.log('[RESPONSE_EMBED_SOURCE_ALIAS] patched full live preview and duplicate grouping');
  }
}
