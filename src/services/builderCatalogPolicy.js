// Which records belong in the Embed Builder (owner's choice): the owner's own
// posts and saved changes, Cloudy's own templates and the fixed notifications.
// Unchanged example templates of the original TitanBot code and templates of
// retired commands stay out. This module only decides: it never reads Discord,
// the database or files, so Search, Modify, the catalog writers and the audit
// script all apply exactly the same rule.
import { createHash } from 'node:crypto';

export const BUILDER_CATALOG_POLICY_VERSION = 1;

const TEMPLATE_KEY_PREFIX = 'cloudy template key:';
const CONTEXT_SEPARATOR = '|| cloudy context:';
const KIND_SEPARATOR = '|| cloudy kind:';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The template key, context and kind Cloudy stores in a catalog embed's author line. */
export function templateMetadata(snapshot) {
  const author = String(snapshot?.author?.name || '').trim();
  if (!author.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX)) return { key: '', context: '', kind: '' };
  let rest = author.slice(TEMPLATE_KEY_PREFIX.length);
  let kind = 'embed';
  const kindAt = rest.toLowerCase().indexOf(KIND_SEPARATOR);
  if (kindAt !== -1) {
    kind = clean(rest.slice(kindAt + KIND_SEPARATOR.length)) || 'embed';
    rest = rest.slice(0, kindAt);
  }
  let context = '';
  const contextAt = rest.toLowerCase().indexOf(CONTEXT_SEPARATOR);
  if (contextAt !== -1) {
    context = clean(rest.slice(contextAt + CONTEXT_SEPARATOR.length));
    rest = rest.slice(0, contextAt);
  }
  return { key: clean(rest), context, kind };
}

/**
 * A fingerprint of a template's words only. Colour, logo, footer, emoji, case,
 * punctuation and live values are ignored, so Cloudy's automatic branding never
 * counts as a change, but any reworded or added text does.
 */
export function templateTextSignature(definition = {}) {
  const kind = clean(definition.kind) === 'content' ? 'content' : 'embed';
  const parts = kind === 'content'
    ? [definition.description ?? definition.content ?? '']
    : [definition.title, definition.description,
      ...(Array.isArray(definition.fields) ? definition.fields.flatMap(field => [field?.name, field?.value]) : [])];
  const text = parts.map(part => String(part ?? '')).join('\n')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/\{dynamic\}/gi, ' ')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return `${kind}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
}

export function isCatalogRecord(record) {
  return clean(record?.source) === 'system-catalog';
}

/** guild + channel + message + embed: one physical Discord embed. */
export function physicalIdentity(record) {
  return [
    String(record?.guildId || ''),
    String(record?.backingChannelId || record?.channelId || ''),
    String(record?.messageId || ''),
    Math.max(0, Number(record?.embedIndex) || 0),
  ].join(':');
}

/** context|key of a catalog template family, '' when the embed carries no metadata. */
export function familyIdentity(record) {
  const metadata = templateMetadata(record?.snapshot || record?.sourceRecord?.snapshot || {});
  return metadata.key ? `${metadata.context}|${metadata.key}` : '';
}

/**
 * Proof that the owner made or saved this record.
 * true = proven, null = only an old manualSaved flag (unproven), false = none.
 */
export function ownerEvidence(record, evidence = {}) {
  const flags = { ...(evidence.ownerFlags || {}) };
  for (const key of ['explicitSave', 'manualSaved']) {
    if (record?.[key] === true) flags[key] = true;
  }
  if (flags.explicitSave === true || evidence.savedOverlay === true || flags.draft === true) return true;
  if (flags.manualSaved === true || evidence.savedOverlay === null) return null;
  return false;
}

/** What the source code says about a template family, or null when unknown. */
function sourceDecision(source) {
  if (!source?.known) return null;
  if (source.retired) return { decision: 'archive', reason: 'retired-command', featureState: 'retired' };
  if (!source.upstreamOriginal) return { decision: 'show', reason: 'cloudy-code', featureState: 'active' };
  if (source.approved) return { decision: 'show', reason: 'approved-feature', featureState: 'active' };
  return { decision: 'archive', reason: 'unchanged-upstream-example', featureState: 'unknown' };
}

/**
 * The single Builder admission rule.
 * record: an existing registry or catalog record.
 * evidence: {
 *   ownerFlags: { explicitSave, manualSaved, draft } merged over every copy of the same embed,
 *   savedOverlay: true | false | null (a saved Builder change for this exact family; null = ambiguous),
 *   fixedTemplate: true for Cloudy's fixed notifications, ticket, casino and Builder templates,
 *   source: { known, retired, upstreamOriginal, approved } from the code and the manifest,
 *   durableDecision: 'show' | 'archive' | null (an earlier recorded decision),
 * }
 */
export function classifyBuilderRecord(record, evidence = {}) {
  if (!isCatalogRecord(record)) {
    // Real Discord messages, Builder posts and drafts are listed as before.
    const own = clean(record?.source) === 'embed-builder' && (record?.manualSaved === true || record?.draftData);
    return {
      identity: `physical:${physicalIdentity(record)}`,
      decision: 'show',
      reasons: [own ? 'builder-post' : 'physical-message'],
      ownerModified: own ? true : null,
      featureState: 'unknown',
    };
  }

  const family = familyIdentity(record);
  const identity = family ? `family:${String(record?.guildId || '')}:${family}` : `physical:${physicalIdentity(record)}`;
  const owner = ownerEvidence(record, evidence);
  const result = (decision, reasons, featureState = 'unknown') => ({
    identity, decision, reasons, ownerModified: owner, featureState,
  });

  if (owner === true) return result('show', ['owner-saved']);
  if (evidence.fixedTemplate) return result('show', ['fixed-cloudy-template'], 'active');
  const fromSource = sourceDecision(evidence.source);
  // An old manualSaved flag is not proof, but it is never thrown away either:
  // it stays for review unless the code already shows the family anyway.
  if (owner === null) {
    return fromSource?.decision === 'show'
      ? result('show', [fromSource.reason], fromSource.featureState)
      : result('review', ['unproven-old-save', ...(fromSource ? [fromSource.reason] : [])],
        fromSource?.featureState || 'unknown');
  }
  if (fromSource) return result(fromSource.decision, [fromSource.reason], fromSource.featureState);
  // The code no longer has this family (renamed or removed file): an earlier
  // decision stays in force, so an archived example never comes back.
  if (evidence.durableDecision === 'show' || evidence.durableDecision === 'archive') {
    return result(evidence.durableDecision, ['recorded-decision']);
  }
  return result('review', ['unknown-origin']);
}

/**
 * Whether the Builder lists a classified record. Review items with an old
 * save flag stay visible (never hide possible own work); while the recorded
 * decisions are unavailable only proven items are listed.
 */
export function isBuilderDecisionVisible(result, { reliable = true } = {}) {
  if (result?.decision === 'show') return true;
  if (result?.decision !== 'review') return false;
  return reliable && result.ownerModified === null;
}
