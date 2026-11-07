import { createHash } from 'node:crypto';
import { builderCatalogFeature } from '../config/builderCatalogManifest.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';

const normalized = value => String(value || '').trim().toLowerCase();

export function builderCatalogMetadata(record = {}) {
  const data = record.snapshot || record.sourceEmbedData || record.sourceRecord?.snapshot || record;
  const author = String(data?.author?.name || '');
  return {
    key: normalized(author.match(/^Cloudy template key:\s*([^|]+)/i)?.[1]),
    context: normalized(author.match(/\|\|\s*Cloudy context:\s*([^|]+)/i)?.[1]),
    kind: normalized(author.match(/\|\|\s*Cloudy kind:\s*([^|]+)/i)?.[1]) || 'embed',
  };
}

export function builderCatalogIdentity(record = {}, metadata = builderCatalogMetadata(record)) {
  const guild = String(record.guildId || '');
  if (normalized(record.source) === 'system-catalog') {
    return ['catalog', guild, metadata.kind, metadata.context, metadata.key].join('|');
  }
  return ['physical', guild, record.backingChannelId || record.channelId || '',
    record.messageId || '', Math.max(0, Number(record.embedIndex) || 0)].join('|');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, stableValue(value[key])]));
}

export function builderCatalogFingerprint(record = {}) {
  const data = record.snapshot || record.sourceEmbedData || record;
  const shape = {};
  // Preserve text and whitespace literally. Ignore only the internal catalog
  // author name; an owner's icon or link alongside that name still counts.
  for (const key of ['title', 'description', 'url', 'color', 'fields', 'footer', 'image', 'thumbnail', 'author']) {
    if (data[key] === undefined || data[key] === null) continue;
    if (key === 'author' && /^Cloudy template key:/i.test(String(data.author?.name || ''))) {
      const author = {...data.author};
      delete author.name;
      if (Object.keys(author).length) shape.author = author;
      continue;
    }
    shape[key] = data[key];
  }
  if (Array.isArray(record.components) && record.components.length) shape.components = record.components;
  return createHash('sha256').update(JSON.stringify(stableValue(shape))).digest('hex');
}

export function classifyBuilderRecord(record = {}, evidence = {}) {
  const metadata = { ...builderCatalogMetadata(record), ...(evidence.metadata || {}) };
  const identity = builderCatalogIdentity(record, metadata);
  const feature = builderCatalogFeature({context: metadata.context, sourcePath: evidence.sourcePath});
  const answer = (decision, reason, ownerModified = null) => ({identity, decision,
    reasons: [reason], ownerModified, featureState: feature.state});
  const data = record.snapshot || record.sourceEmbedData || {};
  const source = normalized(record.source);
  const marked = String(data.footer?.text || '').length > MESSAGE_BUILDER_FOOTER_MARKER.length
    && String(data.footer.text).endsWith(MESSAGE_BUILDER_FOOTER_MARKER);
  if (record.explicitSave === true || evidence.ownerModified === true
      || record.builderWriteVersion === 1 || ['modified', 'modified-template'].includes(source)
      || (source === 'embed-builder' && marked)) {
    return answer('show', 'verified-owner-write', true);
  }
  if (evidence.everUsed === true) return answer('show', 'verified-historical-use', false);
  // A physical post or old Builder source is never destroyed or silently
  // recategorized just because it predates today's proof of a manual write.
  if (source !== 'system-catalog') return answer('review', 'preserve-physical-or-legacy-record');
  if (evidence.curated === true || feature.approved) return answer('show', 'approved-cloudy-family', false);
  const fingerprint = builderCatalogFingerprint(record);
  const prior = evidence.previous;
  if (prior?.identity === identity && prior.decision === 'archive' && prior.fingerprint === fingerprint) {
    return answer('archive', 'previous-exact-archive', false);
  }
  if (evidence.usageState === 'unknown') return answer('review', 'usage-not-yet-verified');
  if (evidence.baseline || evidence.baselineFingerprint || evidence.baselineFingerprints?.length) {
    const baselines = evidence.baselineFingerprints || [evidence.baselineFingerprint || builderCatalogFingerprint(evidence.baseline)];
    if (baselines.includes(fingerprint)) {
      return answer('archive', feature.state === 'retired' ? 'unchanged-retired-source' : 'unchanged-unapproved-source', false);
    }
    return answer('review', 'preserve-difference-from-source');
  }
  return answer('review', 'no-reliable-source-baseline');
}
