import fs from 'node:fs';

const marker = 'BUILDER_SAVED_PARITY_V1';
function patch(path, edits) {
  let text = fs.readFileSync(path, 'utf8');
  if (text.includes(marker)) return;
  for (const [before, after] of edits) {
    if (!text.includes(before)) throw new Error(`Saved parity marker missing in ${path}: ${before.slice(0, 80)}`);
    text = text.replaceAll(before, after);
  }
  fs.writeFileSync(path, `// ${marker}\n${text}`);
}

patch('src/services/embedManagerService.js', [
  ["    return dynamicTemplateText(value)", "    return dynamicTemplateText(value)\n        .replace(/^currency added$/, 'add currency')\n        .replace(/^currency removed$/, 'remove currency')"],
  ["    if (/^blackjack\\s*[\u2014-]\\s*bet\\b/i.test(title)) return 'Blackjack \u2014 Bet';", "    if (/^currency added$/i.test(title)) return 'Add currency';\n    if (/^currency removed$/i.test(title)) return 'Remove currency';\n    if (/^blackjack\\s*[\u2014-]\\s*bet\\b/i.test(title)) return 'Blackjack \u2014 Bet';"],
  ["    if (!/^(?:success|error|information|warning)$/i.test(title) || !description) return false;", "    if (!description && !data.fields?.length && /^change currency (?:name|symbol)$/i.test(title)) return true;\n    if (/\\/(?:embed-template-service|embed-color-picker-session-service|embed-color-picker-page|builder-runtime-preview-service)$/.test(stableSystemTemplateContext(data))) return true;\n    if (!/^(?:success|error|information|warning)$/i.test(title) || !description) return false;"],
  ["import { saveEmbedTemplateDecoration } from './embedTemplateService.js';", "import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from './embedTemplateService.js';\nimport { hydrateBuilderPreviewRecord } from './builderRuntimePreviewService.js';"],
  ["    const snapshot = migrateCloudyLogoEmbedData(record?.snapshot || getEmbedRegistrySnapshot(record) || {}).data || {};", "    const original = migrateCloudyLogoEmbedData(record?.snapshot || getEmbedRegistrySnapshot(record) || {}).data || {};\n    const snapshot = getCachedSavedEmbedTemplateData(record?.guildId, record?.channelId, original).data;"],
  ["    if (stableKey && !/^(?:embed(?:-type)?|source):/i.test(stableKey)) return stableKey;", "    if (/^(?:game:|ticket-log:|ticket-main$)/i.test(stableKey)) return stableKey;"],
  ["        const previewRecord = realRecords.at(-1) || representative;", "        const previewRecord = [...realRecords].sort((a, b) => builderSourceCompleteness(a) - builderSourceCompleteness(b)\n            || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).at(-1) || representative;"],
  ["    const data = migrateCloudyLogoEmbedData(snapshot).data || {};", "    const data = recordEmbedData(record);"],
  ["? (migrateCloudyLogoEmbedData(previewSnapshot).data || {})", "? recordEmbedData(previewRecord)"],
  ["? (migrateCloudyLogoEmbedData(sourceSnapshot).data || {})", "? recordEmbedData(effectiveSourceRecord)"],
  ["    const displayTitle = previewData?.title\n        || sourcePreviewData?.title\n        || sourceData?.title\n        || data.title;", "    const displayTitle = previewData?.title\n        || sourceData?.title\n        || data.title\n        || sourcePreviewData?.title;"],
  ["    const displayDescription = previewData?.description\n        ?? sourcePreviewData?.description\n        ?? sourceData?.description\n        ?? data.description;", "    const displayDescription = previewData?.description\n        || sourceData?.description\n        || data.description\n        || sourcePreviewData?.description;"],
  ["        const storedRecords = await getEmbedRegistry(guild.id);", "        const storedRecords = await getEmbedRegistry(guild.id);\n        await warmSavedEmbedTemplateScopes(guild.id, storedRecords.map(record => record.channelId));"],
  ["                const previewRecord = selectedDisplayRecord?.previewRecord || null;", "                let previewRecord = selectedDisplayRecord?.previewRecord || null;"],
  ["                let loaded = record ? loadRecordSnapshotIntoState", "                if (record) previewRecord = await hydrateBuilderPreviewRecord(guild, record, previewRecord, interaction.user.id).catch(() => previewRecord);\n                let loaded = record ? loadRecordSnapshotIntoState"],
  ["    const displayTitle =", "    let displayTitle ="],
  ["    const displayDescription =", "    let displayDescription ="],
  ["    const displayFields =", "    let displayFields ="],
  ["    const displayFooter =", "    let displayFooter ="],
  ["    const displayImage =", "    let displayImage ="],
  ["    const displayThumbnail =", "    let displayThumbnail ="],
  ["    const footerText = cleanFooter(displayFooter?.text || data.footer?.text || '');", "    const savedDisplay = getCachedSavedEmbedTemplateData(guild.id, String(record.channelId || ''), displaySourceData);\n    if (savedDisplay.matched) {\n        Object.assign(displaySourceData, savedDisplay.data);\n        for (const key of ['title', 'description', 'fields', 'footer', 'image', 'thumbnail']) {\n            if (!(key in savedDisplay.data)) delete displaySourceData[key];\n        }\n        displayTitle = savedDisplay.data.title;\n        displayDescription = savedDisplay.data.description;\n        displayFields = savedDisplay.data.fields;\n        displayFooter = savedDisplay.data.footer;\n        displayImage = savedDisplay.data.image;\n        displayThumbnail = savedDisplay.data.thumbnail;\n    }\n    const footerText = cleanFooter(displayFooter?.text || '');"],
]);

patch('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', [
  ["    return `${record?.channelId}:${titleKey}`;", "    const statusTitle = canonicalBuilderResponseTitle(document.title);\n    if (/^(?:failed|success|warning|error|information|invalid|expired)$/.test(statusTitle)) return `status:${statusTitle}`;\n    return `${record?.channelId}:${titleKey}`;"],
  ["import { collapseDisplayRecords } from '../../services/embedManagerService.js';", "import { collapseDisplayRecords, canonicalBuilderResponseTitle } from '../../services/embedManagerService.js';\nimport { warmSavedEmbedTemplateScopes } from '../../services/embedTemplateService.js';\nimport { hydrateBuilderPreviewRecord } from '../../services/builderRuntimePreviewService.js';"],
  ["const candidates = [data?.title, record?.name, record?.title]", "const candidates = [record?.previewRecord ? record?.name : null, data?.title, record?.name, record?.title]"],
  ["                    previewRecord: record.previewRecord\n                        || latestRealPreviewRecord(interaction.guild, records, record),", "                    previewRecord: await hydrateBuilderPreviewRecord(interaction.guild, record, record.previewRecord || latestRealPreviewRecord(interaction.guild, records, record), interaction.user.id).catch(() => record.previewRecord || latestRealPreviewRecord(interaction.guild, records, record)),"],
  ["const records = await getEmbedRegistry(interaction.guildId);", "const records = await getEmbedRegistry(interaction.guildId);\n        await warmSavedEmbedTemplateScopes(interaction.guildId, records.map(record => record.channelId));"],
]);

patch('src/events/fullResponseCatalogReady.js', [
  ["import { logger } from '../utils/logger.js';", "import { logger } from '../utils/logger.js';\nimport { rememberBuilderRuntimePreview } from '../services/builderRuntimePreviewService.js';"],
  ["  decorateEmbedWithSavedTemplate,", "  decorateEmbedWithSavedTemplate,\n  warmSavedEmbedTemplateScopes,\n  getCachedSavedEmbedTemplateData,"],
  ["function patchInteractionCapture() {", `export async function applySavedResponsePayloadTemplates(payload, source) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  const guildId = source?.guildId || source?.channel?.guild?.id;
  const channelId = source?.channelId || source?.channel?.id;
  if (!guildId || !channelId) return payload;
  if (payload.embeds.some(embed => /^(?:message builder|modify embed)$/i.test(String(embed?.title || embed?.data?.title || '')))) return payload;
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);
  return { ...payload, embeds: payload.embeds.map(embed => {
    const data = embed?.toJSON ? embed.toJSON() : embed;
    if (/^cloudy template key:/i.test(String(data?.author?.name || ''))) return embed;
    return getCachedSavedEmbedTemplateData(guildId, channelId, data).data;
  }) };
}

function patchInteractionCapture() {`],
  ["          outgoing = await applySavedBlackjackPayloadTemplates(outgoing, source);", "          outgoing = await applySavedBlackjackPayloadTemplates(outgoing, source);\n          outgoing = await applySavedResponsePayloadTemplates(outgoing, source);\n          void rememberBuilderRuntimePreview(outgoing, source).catch(error => logger.debug(`Builder runtime preview capture skipped: ${error.message}`));"],
  ["prototype.edit = function cloudyPreStyledMessageEdit(payload, ...args) {", "prototype.edit = async function cloudyPreStyledMessageEdit(payload, ...args) {"],
  ["      outgoing = prepareMessageEditPayload(this, payload);", "      outgoing = prepareMessageEditPayload(this, payload);\n      if (shouldPrepareMessageEdit(this)) {\n        outgoing = await applySavedResponsePayloadTemplates(outgoing, messageContext(this));\n        void rememberBuilderRuntimePreview(outgoing, messageContext(this)).catch(error => logger.debug(`Builder runtime preview capture skipped: ${error.message}`));\n      }"],
]);
console.log('[BUILDER_SAVED_PARITY] Saved titles, complete previews and canonical list identities enabled');
