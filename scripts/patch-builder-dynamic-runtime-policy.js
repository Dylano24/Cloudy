import fs from 'node:fs';

const MARKER = 'BUILDER_DYNAMIC_RUNTIME_POLICY_V1';

function patchFile(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  if (before.includes(MARKER)) return false;
  const after = transform(before);
  if (after === before) throw new Error(`[BUILDER_DYNAMIC_RUNTIME_POLICY] no changes applied to ${path}`);
  fs.writeFileSync(path, `// ${MARKER}\n${after}`);
  return true;
}

function replaceOnce(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`[BUILDER_DYNAMIC_RUNTIME_POLICY] marker missing: ${label}`);
  return text.replace(before, after);
}

patchFile('src/services/embedDefinitionDiscoveryService.js', text => {
  text = replaceOnce(
    text,
    `.map(raw => decodeString(raw, { allowDynamic: false }))`,
    `.map(raw => decodeString(raw, { allowDynamic: marker === '.setTitle(' }))`,
    'dynamic setTitle discovery',
  );

  text = replaceOnce(
    text,
    `  const decoded = decodeString(raw, { allowDynamic: false });\n  return decoded ? [decoded] : [];`,
    `  const decoded = decodeString(raw, { allowDynamic: marker === '.setTitle(' });\n  return decoded ? [decoded] : [];`,
    'dynamic setTitle fallback',
  );
  return text;
});

patchFile('src/services/systemEmbedCatalogService.js', text => {
  text = replaceOnce(
    text,
    `const embedSourceAliases = new Map();\nconst embedLegacyKeyAliases = new Map();`,
    `const embedSourceAliases = new Map();\nconst embedDynamicSourceAliases = new Map();\nconst embedLegacyKeyAliases = new Map();`,
    'dynamic source alias map',
  );

  text = replaceOnce(
    text,
    `function embedLegacyKeyAliasIdentity(context, key) {\n  return cacheIdentity('legacy-key:' + normalize(key), context);\n}\n`,
    `function embedLegacyKeyAliasIdentity(context, key) {\n  return cacheIdentity('legacy-key:' + normalize(key), context);\n}\n\nfunction escapeDynamicPattern(value = '') {\n  return String(value).replace(/[.*+?^\\${}()|[\\]\\\\]/g, '\\\\$&');\n}\n\nfunction dynamicTitleRegex(value = '') {\n  const parts = String(value).split(/\\{dynamic\\}/gi).map(escapeDynamicPattern);\n  if (parts.length <= 1) return null;\n  return new RegExp('^' + parts.join('(.+?)') + '$', 'iu');\n}\n\nfunction registerDynamicEmbedSourceAlias(context, title, key) {\n  if (!/\\{dynamic\\}/i.test(String(title || '')) || !key) return false;\n  const normalizedContext = normalize(context);\n  const entries = embedDynamicSourceAliases.get(normalizedContext) || [];\n  if (!entries.some(entry => entry.key === key && entry.title === title)) {\n    entries.push({ key, title: String(title), matcher: dynamicTitleRegex(title) });\n    embedDynamicSourceAliases.set(normalizedContext, entries);\n  }\n  return true;\n}\n\nfunction resolveDynamicEmbedSourceAlias(context, title) {\n  const exact = normalize(context);\n  const parent = parentContext(exact);\n  const candidates = [\n    ...(embedDynamicSourceAliases.get(exact) || []),\n    ...(parent ? (embedDynamicSourceAliases.get(parent) || []) : []),\n    ...(embedDynamicSourceAliases.get('') || []),\n  ].filter(entry => entry.matcher?.test(String(title || '')));\n  const unique = new Map(candidates.map(entry => [entry.key, entry]));\n  return unique.size === 1 ? [...unique.values()][0] : null;\n}\n`,
    'dynamic source alias helpers',
  );

  text = replaceOnce(
    text,
    `  const identity = embedSourceAliasIdentity(normalized.context, title);\n  const current = embedSourceAliases.get(identity);`,
    `  registerDynamicEmbedSourceAlias(normalized.context, title, normalized.key);\n\n  const identity = embedSourceAliasIdentity(normalized.context, title);\n  const current = embedSourceAliases.get(identity);`,
    'register dynamic source alias',
  );

  text = replaceOnce(
    text,
    `function resolveEmbedSourceAlias(context, title) {\n  const key = embedSourceAliases.get(embedSourceAliasIdentity(context, title));\n  return typeof key === 'string' && key ? key : null;\n}`,
    `function resolveEmbedSourceAlias(context, title) {\n  const key = embedSourceAliases.get(embedSourceAliasIdentity(context, title));\n  if (typeof key === 'string' && key) return key;\n  return resolveDynamicEmbedSourceAlias(context, title)?.key || null;\n}`,
    'resolve dynamic source alias',
  );

  const systemRenderMarker = `function renderDynamic(template, runtime, { fallbackToRuntimeOnMismatch = false } = {}) {\n  const source = String(runtime || '');\n  const templateSource = String(template || '');`;
  const systemRenderReplacement = `function extractDynamicValuesFromTemplate(template, runtime) {\n  const parts = String(template || '').split(/\\{dynamic\\}/gi);\n  if (parts.length <= 1) return [];\n  const pattern = '^' + parts.map(escapeDynamicPattern).join('(.+?)') + '$';\n  const match = String(runtime || '').match(new RegExp(pattern, 'isu'));\n  return match ? match.slice(1) : [];\n}\n\nfunction renderDynamic(template, runtime, { fallbackToRuntimeOnMismatch = false } = {}) {\n  const source = String(runtime || '');\n  const templateSource = String(template || '');`;
  text = replaceOnce(text, systemRenderMarker, systemRenderReplacement, 'system dynamic extraction');

  text = replaceOnce(
    text,
    `  const runtimeParts = dynamicParts(source);\n  const templateParts = dynamicParts(templateSource);\n  const placeholders = templateParts.tokenized.match(/\\{dynamic\\}/gi) || [];\n\n  if (!placeholders.length) return templateSource;\n  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;\n\n  let runtimeIndex = 0;`,
    `  const runtimeParts = dynamicParts(source);\n  const templateParts = dynamicParts(templateSource);\n  const placeholders = templateParts.tokenized.match(/\\{dynamic\\}/gi) || [];\n\n  if (!placeholders.length) return templateSource;\n  let runtimeValues = runtimeParts.values;\n  if (runtimeValues.length !== placeholders.length) {\n    const extracted = extractDynamicValuesFromTemplate(templateSource, source);\n    if (extracted.length === placeholders.length) runtimeValues = extracted;\n  }\n  if (fallbackToRuntimeOnMismatch && runtimeValues.length !== placeholders.length) return source;\n\n  let runtimeIndex = 0;`,
    'system render runtime values',
  );

  text = replaceOnce(
    text,
    `    const runtimeValue = runtimeParts.values[runtimeIndex++];`,
    `    const runtimeValue = runtimeValues[runtimeIndex++];`,
    'system render extracted values',
  );

  const cleanupMarker = `export async function cleanupSystemCatalogEntries(messages) {\n  const groups = new Map();\n  if (PRESERVE_EXISTING_EMBEDS) return false;`;
  const cleanupReplacement = `async function cleanupDynamicRuntimeCatalogArtifacts(messages) {\n  let changed = false;\n  const nextMessages = [];\n\n  for (const message of messages) {\n    const kept = [];\n    let removed = false;\n    for (const embed of message?.embeds || []) {\n      const metadata = parseTemplateMetadata(embed);\n      const data = cloneData(embed);\n      const dynamicSource = resolveDynamicEmbedSourceAlias(metadata.context, data.title);\n      const staleRuntimeKey = dynamicSource\n        && normalize(metadata.key) !== normalize(dynamicSource.key)\n        && normalize(data.title) !== normalize(dynamicSource.title);\n      if (staleRuntimeKey) {\n        removed = true;\n        changed = true;\n        continue;\n      }\n      kept.push(new EmbedBuilder(data));\n    }\n\n    if (!removed) {\n      nextMessages.push(message);\n      continue;\n    }\n    if (!kept.length) {\n      await message.delete?.().catch(() => null);\n      continue;\n    }\n    const edited = await message.edit({ content: CATALOG_CONTENT, embeds: kept }).catch(() => null);\n    nextMessages.push(edited || message);\n  }\n\n  if (changed) messages.splice(0, messages.length, ...nextMessages);\n  return changed;\n}\n\nexport async function cleanupSystemCatalogEntries(messages) {\n  const cleanedDynamicArtifacts = await cleanupDynamicRuntimeCatalogArtifacts(messages);\n  const groups = new Map();\n  if (PRESERVE_EXISTING_EMBEDS) return cleanedDynamicArtifacts;`;
  text = replaceOnce(text, cleanupMarker, cleanupReplacement, 'dynamic runtime catalog cleanup');

  text = replaceOnce(
    text,
    `  embedSourceAliases.clear();\n  embedLegacyKeyAliases.clear();`,
    `  embedSourceAliases.clear();\n  embedDynamicSourceAliases.clear();\n  embedLegacyKeyAliases.clear();`,
    'clear dynamic aliases',
  );

  return text;
});

patchFile('src/services/embedTemplateService.js', text => {
  const renderMarker = `function renderDynamic(template, runtime, {\n  fallbackToRuntimeOnMismatch = false,\n  preserveRuntimeWhenNoDynamic = false,\n} = {}) {\n  const source = String(runtime || '');\n  const templateSource = String(template || '');`;
  const renderReplacement = `function escapeDynamicPattern(value = '') {\n  return String(value).replace(/[.*+?^\\${}()|[\\]\\\\]/g, '\\\\$&');\n}\n\nfunction extractDynamicValuesFromTemplate(template, runtime) {\n  const parts = String(template || '').split(/\\{dynamic\\}/gi);\n  if (parts.length <= 1) return [];\n  const pattern = '^' + parts.map(escapeDynamicPattern).join('(.+?)') + '$';\n  const match = String(runtime || '').match(new RegExp(pattern, 'isu'));\n  return match ? match.slice(1) : [];\n}\n\nfunction dynamicAliasMatches(alias, value) {\n  const matcher = /\\{dynamic\\}/i.test(String(alias || ''))\n    ? new RegExp('^' + String(alias).split(/\\{dynamic\\}/gi).map(escapeDynamicPattern).join('(.+?)') + '$', 'iu')\n    : null;\n  return Boolean(matcher?.test(normalizeKey(value)));\n}\n\nfunction renderDynamic(template, runtime, {\n  fallbackToRuntimeOnMismatch = false,\n  preserveRuntimeWhenNoDynamic = false,\n} = {}) {\n  const source = String(runtime || '');\n  const templateSource = String(template || '');`;
  text = replaceOnce(text, renderMarker, renderReplacement, 'saved template dynamic extraction');

  text = replaceOnce(
    text,
    `  const runtimeParts = dynamicParts(source);\n  const templateParts = dynamicParts(templateSource);\n  const placeholders = templateParts.tokenized.match(/\\{dynamic\\}/gi) || [];\n\n  if (!placeholders.length) {\n    if (preserveRuntimeWhenNoDynamic && source && source !== templateSource) return source;\n    return templateSource;\n  }\n\n  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;\n\n  let runtimeIndex = 0;`,
    `  const runtimeParts = dynamicParts(source);\n  const templateParts = dynamicParts(templateSource);\n  const placeholders = templateParts.tokenized.match(/\\{dynamic\\}/gi) || [];\n\n  if (!placeholders.length) {\n    if (preserveRuntimeWhenNoDynamic && source && source !== templateSource) return source;\n    return templateSource;\n  }\n\n  let runtimeValues = runtimeParts.values;\n  if (runtimeValues.length !== placeholders.length) {\n    const extracted = extractDynamicValuesFromTemplate(templateSource, source);\n    if (extracted.length === placeholders.length) runtimeValues = extracted;\n  }\n  if (fallbackToRuntimeOnMismatch && runtimeValues.length !== placeholders.length) return source;\n\n  let runtimeIndex = 0;`,
    'saved template runtime values',
  );

  text = replaceOnce(
    text,
    `    const runtimeValue = runtimeParts.values[runtimeIndex++];`,
    `    const runtimeValue = runtimeValues[runtimeIndex++];`,
    'saved template extracted values',
  );

  text = replaceOnce(
    text,
    `  return candidates.map(candidate => stored[candidate]).find(Boolean) || null;`,
    `  const exact = candidates.map(candidate => stored[candidate]).find(Boolean) || null;\n  if (exact) return exact;\n\n  const rawTitle = normalizeKey(data.title);\n  const dynamicMatches = Object.entries(stored)\n    .filter(([alias, template]) => template && dynamicAliasMatches(alias, rawTitle))\n    .sort(([left], [right]) => right.replace(/\\{dynamic\\}/gi, '').length - left.replace(/\\{dynamic\\}/gi, '').length);\n  return dynamicMatches[0]?.[1] || null;`,
    'dynamic saved-template alias lookup',
  );

  text = replaceOnce(
    text,
    `  const aliasesToFind = aliasKeys(embedData.title);\n  let template = null;\n  for (const scope of scopes) {\n    template = aliasesToFind.map(alias => scope?.[alias]).find(Boolean);\n    if (template) break;\n  }`,
    `  let template = null;\n  for (const scope of scopes) {\n    if (!scope) continue;\n    template = findStoredTemplate(embedData, scope, { strictTitle: true });\n    if (template) break;\n  }`,
    'cached dynamic saved-template lookup',
  );

  return text;
});

patchFile('src/services/embedManagerService.js', text => {
  text = replaceOnce(
    text,
    `function standardDynamicTemplateName(value) {\n    const title = String(value || '').replace(/\\s+/g, ' ').trim();`,
    `function standardDynamicTemplateName(value) {\n    const title = String(value || '').replace(/\\s+/g, ' ').trim();\n    const possessiveDynamic = title.match(/^\\{dynamic\\}(?:'s)?\\s+(.+)$/i);\n    if (possessiveDynamic?.[1]) return possessiveDynamic[1].trim();`,
    'generic dynamic display name',
  );

  text = replaceOnce(
    text,
    `    let displayTitle = previewData?.title\n        || sourceData?.title\n        || data.title\n        || sourcePreviewData?.title;`,
    `    const dynamicSourceTitle = /\\{dynamic\\}/i.test(String(sourcePreviewData?.title || ''))\n        ? sourcePreviewData.title\n        : null;\n    let displayTitle = dynamicSourceTitle\n        || previewData?.title\n        || sourceData?.title\n        || data.title\n        || sourcePreviewData?.title;`,
    'prefer generic dynamic source title',
  );

  return text;
});

console.log('[BUILDER_DYNAMIC_RUNTIME_POLICY] dynamic runtime text stays live; user-specific titles collapse to source templates');
