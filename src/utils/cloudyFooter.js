import { REST } from '@discordjs/rest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MESSAGE_BUILDER_FOOTER_MARKER, isMentionOnlyContent } from '../services/cloudyBrandingService.js';
import { isRegisteredBuilderPreviewMessageId } from './builderSessionCleanup.js';

export { isMentionOnlyContent } from '../services/cloudyBrandingService.js';

export const CLOUDY_STANDARD_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const MARKER = Symbol.for('cloudy.standard-footer-output');
const DEFERRED_REPLY_TTL_MS = 15 * 60_000;
const deferredReplyTokens = new Map();
const pendingBuilderPreviewReplyTokens = new Set();
const manualBuilderSaveMessageIds = new Set();
const manualBuilderPostScope = new AsyncLocalStorage();
const submittedReportNumberScope = new AsyncLocalStorage();
const reportNoticeNumberScope = new AsyncLocalStorage();
const reportStaffLogScope = new AsyncLocalStorage();
const creatorErrorScope = new AsyncLocalStorage();
const APPEAL_TITLE_PATTERN = /^(?:Discord|Rust server) appeal(?:\s*[—-]\s*|\s+)(?:Mute|Ban|Other)$/i;

// Scoped exceptions to the global automatic C-logo insertion. Footer branding
// still applies, and ordinary Cloudy messages keep their original logo policy.
export function registerBuilderPreviewReplyToken(token) {
  if (!token) return false;
  pendingBuilderPreviewReplyTokens.add(String(token));
  return true;
}

// A newly posted Builder message has no ID yet. Preserve its no-logo choice
// only for this async send call, never for unrelated sends in the same channel.
export function withManualBuilderPostLogoChoice(callback) {
  return manualBuilderPostScope.run(true, callback);
}

// Carry the actual reserved report number to the final Discord REST request.
// Scoped per submission: concurrent reports cannot leak each other's number.
export function withReportSubmittedNumber(reportNumber, callback) {
  const number = Number(reportNumber);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid report number for confirmation.');
  return submittedReportNumberScope.run(number, callback);
}

export function ensureOutgoingReportConfirmationFooter(payload) {
  const number = submittedReportNumberScope.getStore();
  if (!number || !Array.isArray(payload?.embeds)) return payload;
  let changed = false;
  const embeds = payload.embeds.map(source => {
    const embed = source?.toJSON?.() || source;
    if (embed?.title !== 'Report submitted') return source;
    changed = true;
    // The confirmation has no logo (owner's choice); removed last, after
    // every branding or template layer that may have added one.
    const { thumbnail: _logo, ...withoutLogo } = embed;
    return { ...withoutLogo, footer: { text: `Cloudy Inc. • Moderation team • R${number}` } };
  });
  return changed ? { ...payload, embeds } : payload;
}

// Private reporter/target notice footers must use the number visible in the
// actual case channel, not an older historical record's number.
export function withReportCaseNoticeNumber(reportNumber, callback) {
  const number = Number(reportNumber);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid private report channel number.');
  return reportNoticeNumberScope.run(number, callback);
}

export function ensureOutgoingReportCaseNoticeFooter(payload) {
  const number = reportNoticeNumberScope.getStore();
  if (!number || !Array.isArray(payload?.embeds)) return payload;
  let changed = false;
  const embeds = payload.embeds.map(source => {
    const embed = source?.toJSON?.() || source;
    if (!['Report update', 'Moderation update'].includes(embed?.title)) return source;
    changed = true;
    return { ...embed, footer: { text: `Cloudy Inc. • Moderation team • R${number}` } };
  });
  return changed ? { ...payload, embeds } : payload;
}

// Keep report staff logs distinct from the two private report notifications.
// They use Cloudy's standard footer and its C thumbnail, not a case R-footer.
export function withReportStaffLogBranding(callback) {
  return reportStaffLogScope.run(true, callback);
}

export function ensureOutgoingReportStaffLogBranding(payload) {
  if (!reportStaffLogScope.getStore() || !Array.isArray(payload?.embeds)) return payload;
  let changed = false;
  const titles = new Set([
    'Report update', 'Moderation update',
    'Report update closed', 'Moderation update closed',
    'Report update deleted', 'Report moderation deleted',
  ]);
  const embeds = payload.embeds.map(source => {
    const original = source?.toJSON?.() || source;
    if (!titles.has(original?.title)
      || !original.fields?.some(field => field.name === 'Report' && /^#\d+$/.test(field.value || ''))) return source;
    if (original.footer?.text === CLOUDY_STANDARD_FOOTER
      && original.thumbnail?.url === CLOUDY_C_LOGO_URL) return source;
    changed = true;
    return { ...original,
      footer: { text: CLOUDY_STANDARD_FOOTER },
      thumbnail: { url: CLOUDY_C_LOGO_URL },
    };
  });
  return changed ? { ...payload, embeds } : payload;
}

// Creator errors have a strict red sidebar. Keep this decision through
// template/branding transformations right up to the Discord REST request.
export function withCreatorErrorColor(callback) {
  return creatorErrorScope.run(true, callback);
}

export function ensureCreatorErrorColor(payload) {
  if (!creatorErrorScope.getStore() || !Array.isArray(payload?.embeds)) return payload;
  let changed = false;
  const embeds = payload.embeds.map(source => {
    const embed = source?.toJSON?.() || source;
    if (embed?.title !== 'Creator notification error' && embed?.title !== 'Access denied') return source;
    changed = true;
    return { ...embed, color: 0x7A1712 };
  });
  return changed ? { ...payload, embeds } : payload;
}

export async function withManualBuilderSaveLogoChoice(messageId, callback) {
  const key = String(messageId || '');
  if (!key) return callback();
  manualBuilderSaveMessageIds.add(key);
  try {
    return await callback();
  } finally {
    manualBuilderSaveMessageIds.delete(key);
  }
}

export function withCloudyFooter(payload, { isNewMessage = true, suppressAutomaticLogo = false, appealChannel = false } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Number(payload.flags) & 32768) return payload;
  // Bare tags are companion messages, never separate branded notices.
  // A tagged message WITH an embed must still get the normal Cloudy branding.
  if (isMentionOnlyContent(payload.content) && !payload.embeds?.length) return payload;
  if (Array.isArray(payload.embeds) && payload.embeds.length) {
    let changed = false;
    const embeds = payload.embeds.map(source => {
      const original = source?.toJSON?.() || source || {};
      if (original.type && original.type !== 'rich') return source;
      const title = String(original.title || '').trim();
      // A submitted report has a real reserved case number. Preserve its
      // explicit moderation footer through both interaction and webhook REST.
      if (title === 'Report submitted'
          && /^Cloudy Inc\. • Moderation team • R[1-9]\d*$/.test(original.footer?.text || '')) return source;
      // Appeal embeds use the normal Cloudy footer without a time, as reports
      // do; the handling time is shown in their Handled at field.
      if (appealChannel || APPEAL_TITLE_PATTERN.test(title)) {
        if (original.footer?.text === CLOUDY_STANDARD_FOOTER && !original.footer.icon_url && !original.timestamp) return source;
        changed = true;
        const embed = { ...original, footer: { text: CLOUDY_STANDARD_FOOTER } };
        delete embed.timestamp;
        return embed;
      }
      // Protect the ZORP Guide and explicitly saved Embed Builder content.
      if (/\bZORP Guide\s*$/i.test(title)
          || original.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)) return source;
      const embed = { ...original };
      let embedChanged = false;
      // A footer already present on the incoming embed may be an intentional
      // no-logo Save. Do not interpret the standard footer as permission to
      // re-add a thumbnail on this or future message edits.
      const hasExistingFooter = Boolean(
        original.footer?.text || original.footer?.icon_url || original.footer?.iconURL
      );
      if (isNewMessage && embed.description === 'Only owners can ban members from reports.') {
        embed.title = 'Permission denied';
        embed.thumbnail = { url: CLOUDY_C_LOGO_URL };
        embedChanged = true;
      }
      // A logo isn't a footer. Keep a custom footer untouched.
      if (!embed.footer?.text && !embed.footer?.icon_url && !embed.footer?.iconURL) {
        embed.footer = { text: CLOUDY_STANDARD_FOOTER };
        embedChanged = true;
      }
      // An explicitly saved non-standard footer can belong to a Builder
      // message where the owner intentionally removed the logo.
      if (isNewMessage && !suppressAutomaticLogo && !hasExistingFooter
          && title.toLowerCase() !== 'message builder'
          && !embed.thumbnail?.url && embed.footer?.text === CLOUDY_STANDARD_FOOTER) {
        embed.thumbnail = { url: CLOUDY_C_LOGO_URL };
        embedChanged = true;
      }
      changed ||= embedChanged;
      return embedChanged ? embed : source;
    });
    return changed ? { ...payload, embeds } : payload;
  }

  // No gray embed, no branding. This includes plain text, mentions, command
  // acknowledgements, components and attachments: do not attach a footer line
  // or invent a separate empty embed just for Cloudy branding.
  return payload;
}

// Keep report confirmations branded even before Discord REST sends them.
// Existing saved custom footers remain untouched.
export function ensureReportSubmittedFooter(embed) {
  if (embed?.data && !embed.data.footer?.text) {
    embed.data.footer = { text: CLOUDY_STANDARD_FOOTER };
  }
  return embed;
}

// Final transport guard: older system templates and presentation middleware
// must not recolor music replies or the live music panel green. Only Cloudy's
// own music message shapes are touched; all other embeds retain their style.
export function ensureWhiteMusicEmbeds(payload) {
  if (!Array.isArray(payload?.embeds)) return payload;
  let changed = false;
  const embeds = payload.embeds.map(source => {
    const data = source?.toJSON?.() || source;
    const names = new Set((data?.fields || []).map(field => field.name));
    const panel = data?.title === 'Now playing'
      && names.has('Artist') && names.has('Status') && names.has('Loop') && names.has('Queue');
    const request = ['Now playing', 'Added to queue'].includes(data?.title)
      && names.has('Requested by') && names.has('Duration');
    if (!panel && !request) return source;
    if (data.color === 0xFFFFFF) return source;
    changed = true;
    return { ...data, color: 0xFFFFFF };
  });
  return changed ? { ...payload, embeds } : payload;
}

export function installCloudyFooterOutput() {
  const prototype = REST.prototype;
  if (prototype[MARKER]) return;
  const original = prototype.request;
  prototype.request = function requestWithCloudyFooter(options) {
    const route = String(options.fullRoute || '');
    const isMessage = /^\/(?:channels\/\d+\/messages(?:\/\d+)?|webhooks\/\d+\/[^/]+(?:\/messages\/[^/]+)?)$/.test(route);
    const isCallback = /^\/interactions\/\d+\/[^/]+\/callback$/.test(route);
    if (isCallback && options.body?.type === 5) {
      const token = route.match(/^\/interactions\/\d+\/([^/]+)\/callback$/)?.[1];
      const result = original.call(this, options);
      if (!token) return result;
      return Promise.resolve(result).then(response => {
        const now = Date.now();
        for (const [key, expiresAt] of deferredReplyTokens) {
          if (expiresAt <= now) deferredReplyTokens.delete(key);
        }
        if (deferredReplyTokens.size >= 1_000) {
          deferredReplyTokens.delete(deferredReplyTokens.keys().next().value);
        }
        deferredReplyTokens.set(token, now + DEFERRED_REPLY_TTL_MS);
        return response;
      });
    }

    if (isMessage && ['POST', 'PATCH'].includes(options.method)) {
      const editedMessageId = options.method === 'PATCH'
        ? route.match(/^\/(?:channels\/\d+\/messages|webhooks\/\d+\/[^/]+\/messages)\/([^/]+)$/)?.[1]
        : null;
      const preserveExplicitLogo = Boolean(
        (options.method === 'POST' && manualBuilderPostScope.getStore() === true)
        || (editedMessageId && (
          isRegisteredBuilderPreviewMessageId(editedMessageId)
          || manualBuilderSaveMessageIds.has(editedMessageId)
        ))
      );
      const deferredOriginalToken = options.method === 'PATCH'
        ? route.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/)?.[1]
        : null;
      const expiresAt = deferredOriginalToken ? deferredReplyTokens.get(deferredOriginalToken) : null;
      const isDeferredInitialReply = Number.isFinite(expiresAt) && expiresAt > Date.now();
      if (expiresAt && !isDeferredInitialReply) deferredReplyTokens.delete(deferredOriginalToken);
      options = {
        ...options,
        body: withCloudyFooter(options.body, {
          isNewMessage: options.method === 'POST' || isDeferredInitialReply,
          suppressAutomaticLogo: preserveExplicitLogo,
          appealChannel: /^\/channels\/1554538665068200039\/messages(?:\/\d+)?$/.test(route),
        }),
      };
    } else if (isCallback && [4, 7].includes(options.body?.type)) {
      const replyToken = route.match(/^\/interactions\/\d+\/([^/]+)\/callback$/)?.[1];
      const isBuilderPreviewReply = options.body.type === 4
        && replyToken && pendingBuilderPreviewReplyTokens.delete(replyToken);
      options = {
        ...options,
        body: {
          ...options.body,
          data: withCloudyFooter(options.body.data, {
            isNewMessage: options.body.type === 4,
            suppressAutomaticLogo: Boolean(isBuilderPreviewReply),
          }),
        },
      };
    }
    // Last mutation before the Discord API request: resolve the relevant
    // scoped report footer policy only after general Cloudy branding.
    if (isMessage && ['POST', 'PATCH'].includes(options.method)) {
      options = { ...options, body: ensureCreatorErrorColor(ensureOutgoingReportStaffLogBranding(
        ensureOutgoingReportCaseNoticeFooter(
          ensureOutgoingReportConfirmationFooter(options.body)))) };
    } else if (isCallback && [4, 7].includes(options.body?.type)) {
      options = { ...options, body: { ...options.body,
        data: ensureCreatorErrorColor(ensureOutgoingReportStaffLogBranding(
          ensureOutgoingReportCaseNoticeFooter(
            ensureOutgoingReportConfirmationFooter(options.body.data)))) } };
    }
    // Perform this after all generic Cloudy formatting, at the actual REST
    // boundary, including both slash-command replies and message edits.
    if (isMessage && ['POST', 'PATCH'].includes(options.method)) {
      options = { ...options, body: ensureWhiteMusicEmbeds(options.body) };
    } else if (isCallback && [4, 7].includes(options.body?.type)) {
      options = { ...options, body: { ...options.body,
        data: ensureWhiteMusicEmbeds(options.body.data) } };
    }
    return original.call(this, options);
  };
  Object.defineProperty(prototype, MARKER, { value: true });
}
