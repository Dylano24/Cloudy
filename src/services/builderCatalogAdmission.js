// Applies the Builder admission rule (builderCatalogPolicy.js) with live
// evidence: the owner flags of every stored copy of an embed and the owner's
// saved Builder changes. Search, Modify and the offered selections all use
// this one function (owner's choice).
import { isCatalogRecord, templateMetadata } from './builderCatalogPolicy.js';
import {
  canonicalSystemEmbedResponseTitle,
  getSearchableSystemCatalogRecords,
  getSearchableSystemCatalogRevision,
  isBuilderCatalogRecordVisible,
} from './systemEmbedCatalogService.js';
import { getCachedSavedEmbedTemplateData, isSavedEmbedTemplateScopeWarm } from './embedTemplateService.js';
import { getEmbedRegistryGeneration, peekEmbedRegistry } from './embedRegistryService.js';

// Message IDs are unique, so guild + message + embed names one physical embed
// whichever (feature or botlog) channel a copy records.
function embedKey(record) {
  return `${String(record?.guildId || '')}:${String(record?.messageId || '')}:${Math.max(0, Number(record?.embedIndex) || 0)}`;
}

function mergeFlags(...items) {
  const flags = {};
  for (const item of items) {
    if (item?.explicitSave === true) flags.explicitSave = true;
    if (item?.manualSaved === true) flags.manualSaved = true;
  }
  return flags;
}

/** explicitSave/manualSaved of every copy of the same physical embed. */
export function collectBuilderOwnerFlags(records = []) {
  const index = new Map();
  for (const record of records || []) {
    if (record?.explicitSave !== true && record?.manualSaved !== true) continue;
    const key = embedKey(record);
    index.set(key, mergeFlags(index.get(key), record));
  }
  return index;
}

const registryFlagIndexes = new Map();
function registryOwnerFlags(record) {
  const guildId = String(record?.guildId || '');
  if (!guildId) return null;
  const generation = getEmbedRegistryGeneration(guildId);
  let cached = registryFlagIndexes.get(guildId);
  if (!cached || cached.generation !== generation) {
    cached = { generation, index: collectBuilderOwnerFlags(peekEmbedRegistry(guildId, { clone: false }) || []) };
    registryFlagIndexes.set(guildId, cached);
  }
  return cached.index.get(embedKey(record)) || null;
}

// Visible title -> the template families (context|key) that use it, over the
// stored catalog rows and the in-memory catalog of this server.
const titleFamilyIndexes = new Map();
function familiesWithTitle(guildId, title) {
  const revision = `${getEmbedRegistryGeneration(guildId)}:${getSearchableSystemCatalogRevision(guildId)}`;
  let cached = titleFamilyIndexes.get(guildId);
  if (!cached || cached.revision !== revision) {
    const index = new Map();
    const rows = [...(peekEmbedRegistry(guildId, { clone: false }) || []), ...getSearchableSystemCatalogRecords(guildId)];
    for (const row of rows) {
      if (!isCatalogRecord(row)) continue;
      const metadata = templateMetadata(row.snapshot || {});
      const name = canonicalSystemEmbedResponseTitle(row.snapshot?.title || row.title || '');
      if (!metadata.key || !name) continue;
      if (!index.has(name)) index.set(name, new Set());
      index.get(name).add(`${metadata.context}|${metadata.key}`);
    }
    cached = { revision, index };
    titleFamilyIndexes.set(guildId, cached);
  }
  return cached.index.get(canonicalSystemEmbedResponseTitle(title || ''))?.size || 0;
}

/**
 * How a saved Builder change relates to this template family:
 * 'family' (saved for this exact family), 'ambiguous-title' (only matched a
 * title that two families share: proves nothing), 'none', or 'not-loaded'.
 */
export function savedOverlayMatch(record) {
  const guildId = String(record?.guildId || '');
  const channelId = String(record?.channelId || '');
  const data = record?.snapshot || {};
  if (!guildId || !isSavedEmbedTemplateScopeWarm(guildId, channelId)) return 'not-loaded';
  if (templateMetadata(data).key
    && getCachedSavedEmbedTemplateData(guildId, channelId, { author: data.author, title: '' }).matched) return 'family';
  if (!data.title || !getCachedSavedEmbedTemplateData(guildId, channelId, data).matched) return 'none';
  return familiesWithTitle(guildId, data.title) <= 1 ? 'family' : 'ambiguous-title';
}

/** Whether the Builder lists this record. Only catalog templates can be left out. */
export function isBuilderRecordAdmitted(record, { ownerFlags = null } = {}) {
  if (!isCatalogRecord(record)) return true;
  return isBuilderCatalogRecordVisible(record, {
    ownerFlags: mergeFlags(ownerFlags, registryOwnerFlags(record), record),
    // Only a change saved for this exact family is proof (never a shared title).
    savedOverlay: savedOverlayMatch(record) === 'family',
    // Until the saved changes are loaded only proven items are listed.
    reliable: isSavedEmbedTemplateScopeWarm(String(record?.guildId || ''), String(record?.channelId || '')),
  });
}
