import fs from 'node:fs';

function edit(file, before, after) {
  const text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  if (text.includes(after)) return;
  if (!text.includes(before)) {
    console.log(`[BALANCE_SOURCE_IDENTITY] legacy anchor already evolved in ${file}; skipping obsolete migration step`);
    return;
  }
  fs.writeFileSync(file, text.replace(before, after));
}

for (const [file, names] of [
  ['src/services/embedManagerService.js', 'BALANCE_RESPONSE_KEY, balanceResponseIdentity, isLegacyBalanceParserArtifact'],
  ['src/services/embedTemplateService.js', 'BALANCE_RESPONSE_KEY, balanceResponseIdentity, readLegacyBalanceTemplate'],
  ['src/services/systemEmbedCatalogService.js', 'BALANCE_RESPONSE_KEY, balanceResponseIdentity'],
]) {
  const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
  edit(file, first + '\n', first + `\nimport { ${names} } from './balanceResponseIdentity.js';\n`);
}

// A Builder snapshot itself contains dynamic placeholders. It must receive the
// saved fixed text even though it has no concrete member/amount to substitute.
for (const file of ['src/services/embedTemplateService.js', 'src/services/systemEmbedCatalogService.js']) {
  edit(file,
    "  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;",
    "  const runtimeSlots = source.match(/\\{dynamic\\}/gi) || [];\n  if (!runtimeParts.values.length && runtimeSlots.length === placeholders.length) return templateParts.tokenized;\n  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;");
}

edit('src/services/embedManagerService.js',
  "    if (String(record?.source || '') !== 'system-catalog') return false;\n    const data = recordEmbedData(record);\n    const title =",
  "    if (String(record?.source || '') !== 'system-catalog') return false;\n    const data = recordEmbedData(record);\n    if (isLegacyBalanceParserArtifact(data)) return true;\n    const title =");
edit('src/services/embedManagerService.js',
  "    const ticketLog = canonicalTicketLogTemplate(data);",
  "    const balanceIdentity = balanceResponseIdentity(data);\n    if (balanceIdentity) return balanceIdentity;\n    const ticketLog = canonicalTicketLogTemplate(data);");
edit('src/services/embedManagerService.js',
  "    const stableKey = stableSystemTemplateKey(data);\n    if (!/^(?:embed|embed-type):/i.test(stableKey)) return false;",
  "    const stableKey = stableSystemTemplateKey(data);\n    if (balanceResponseIdentity(data)) return false;\n    if (!/^(?:embed|embed-type):/i.test(stableKey)) return false;");
edit('src/services/embedManagerService.js',
  "        const identity = saved.canonicalIdentity || templateIdentity(record.channelId, raw);",
  "        const identity = balanceResponseIdentity(raw) || saved.canonicalIdentity || templateIdentity(record.channelId, raw);");
edit('src/services/embedManagerService.js',
  "    const templateSourceData = {\n        ...(sourceData || {}),\n        ...(sourcePreviewData || {}),\n    };",
  "    const templateSourceData = {\n        ...(sourcePreviewData || {}),\n        ...(sourceData || {}),\n    };");
edit('src/services/embedManagerService.js',
  "    if (edited === live) return template;",
  "    // Restore variable slots only; unchanged visible text must never restore\n    // the default source's old capitalization, labels or wording.\n    if (edited === live && template === live) return edited;");
edit('src/services/embedManagerService.js',
  "    data.color = state.sideColor;\n\n    if (state.removeExistingLogo)",
  "    if (target?.templateTitle === BALANCE_RESPONSE_KEY) {\n        data.author = { ...(data.author || {}), name: `Cloudy template key: ${BALANCE_RESPONSE_KEY} || Cloudy context: gambling/balance || Cloudy kind: embed` };\n    }\n    data.color = state.sideColor;\n\n    if (state.removeExistingLogo)");

edit('src/services/embedTemplateService.js',
  "    removeRetiredGamblingGuideCommand(migrateCloudyLogoEmbedData(template).data || template),",
  "    readLegacyBalanceTemplate(key, removeRetiredGamblingGuideCommand(migrateCloudyLogoEmbedData(template).data || template)),");
edit('src/services/embedTemplateService.js',
  "    schemaVersion: 3,",
  "    schemaVersion: options.canonicalIdentity === BALANCE_RESPONSE_KEY ? 4 : 3,");
edit('src/services/embedTemplateService.js',
  "function findStoredTemplate(data, stored, { strictTitle = false } = {}) {",
  "function findStoredTemplate(data, stored, { strictTitle = false, responseIdentity = null } = {}) {");
edit('src/services/embedTemplateService.js',
  "    metadataAlias(data),\n    data.title,",
  "    responseIdentity || balanceResponseIdentity(data),\n    metadataAlias(data),\n    data.title,");
edit('src/services/embedTemplateService.js',
  "export function getCachedSavedEmbedTemplateData(guildId, channelId, embedData) {",
  "export function getCachedSavedEmbedTemplateData(guildId, channelId, embedData, options = {}) {");
edit('src/services/embedTemplateService.js',
  "  const aliasesToFind = [metadataAlias(embedData), ...aliasKeys(embedData.title)].filter(Boolean);",
  "  const aliasesToFind = [options.responseIdentity || balanceResponseIdentity(embedData), metadataAlias(embedData), ...aliasKeys(embedData.title)].filter(Boolean);");
edit('src/services/embedTemplateService.js',
  "  const aliases = [metadataAlias(embedData), ...aliasKeys(embedData.title)].filter(Boolean);",
  "  const aliases = [options.responseIdentity || balanceResponseIdentity(embedData), metadataAlias(embedData), ...aliasKeys(embedData.title)].filter(Boolean);");

edit('src/events/fullResponseCatalogReady.js',
  "import { rememberTransientPayloadIntent } from '../utils/transientResponse.js';",
  "import { rememberTransientPayloadIntent } from '../utils/transientResponse.js';\nimport { balanceResponseIdentity } from '../services/balanceResponseIdentity.js';");
edit('src/events/fullResponseCatalogReady.js',
  "    return getCachedSavedEmbedTemplateData(guildId, channelId, data).data;",
  "    return getCachedSavedEmbedTemplateData(guildId, channelId, data, { responseIdentity: balanceResponseIdentity(data, source) }).data;");

edit('src/services/systemEmbedCatalogService.js',
  "  const normalizedTitle = dynamicParts(title).pattern;\n\n  if (normalizedKind === 'embed'",
  "  const normalizedTitle = dynamicParts(title).pattern;\n  if (normalizedKind === 'embed' && balanceResponseIdentity({ title }, normalizedContext)) return BALANCE_RESPONSE_KEY;\n\n  if (normalizedKind === 'embed'");
edit('src/services/systemEmbedCatalogService.js',
  "function semanticCatalogKey(metadata, embed) {\n",
  "function semanticCatalogKey(metadata, embed) {\n  const balanceIdentity = balanceResponseIdentity(cloneData(embed));\n  if (balanceIdentity) return balanceIdentity;\n");
edit('src/services/systemEmbedCatalogService.js',
  "  const specificKey = resolveEmbedSourceAlias(context, data.title)",
  "  const specificKey = balanceResponseIdentity(data, context) || resolveEmbedSourceAlias(context, data.title)");

console.log('[PATCH] Balance uses one source identity; Builder Saves retain edited fixed text.');
