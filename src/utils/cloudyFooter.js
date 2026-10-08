import { REST } from '@discordjs/rest';
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

// Scoped exceptions to the global automatic C-logo insertion. Footer branding
// still applies, and ordinary Cloudy messages keep their original logo policy.
export function registerBuilderPreviewReplyToken(token) {
  if (!token) return false;
  pendingBuilderPreviewReplyTokens.add(String(token));
  return true;
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

function addFooterEmbed(payload) {
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  if (embeds.length >= 10) return payload;
  return { ...payload, embeds: [...embeds, { footer: { text: CLOUDY_STANDARD_FOOTER } }] };
}

export function withCloudyFooter(payload, { isNewMessage = true, suppressAutomaticLogo = false } = {}) {
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
      // Protect the ZORP Guide and explicitly saved Embed Builder content.
      if (/\bZORP Guide\s*$/i.test(title)
          || original.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)) return source;
      const embed = { ...original };
      let embedChanged = false;
      if (embed.description === 'Only owners can ban members from reports.') {
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
      if (!suppressAutomaticLogo
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

  // A partial edit does not include the existing message's embeds/footer, so
  // leave it alone unless this is the first edit after deferReply().
  if (!isNewMessage && !Array.isArray(payload.embeds)) return payload;

  const content = typeof payload.content === 'string' ? payload.content : '';
  if (/(?:©\s*)?Cloudy\s+Inc\.?\s*•\s*Quality\.?\s*Innovation\.?\s*Performance\.?/i.test(content)) return payload;

  if (content.trim()) {
    const brandedContent = `${content}\n\n${CLOUDY_STANDARD_FOOTER}`;
    return brandedContent.length <= 2000
      ? { ...payload, content: brandedContent }
      : addFooterEmbed(payload);
  }

  // An explicitly empty content field is commonly used to clear a message.
  // Keep that operation intact; brand component/attachment-only new messages.
  if (content === '' && payload.content === '' && !isNewMessage) return payload;
  if (content === '' && payload.content === '' && isNewMessage
    && !payload.components?.length && !payload.attachments?.length && !payload.files?.length) return payload;
  if (payload.components?.length || payload.attachments?.length || payload.files?.length) {
    return addFooterEmbed(payload);
  }
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
      const preserveExplicitLogo = Boolean(editedMessageId && (
        isRegisteredBuilderPreviewMessageId(editedMessageId)
        || manualBuilderSaveMessageIds.has(editedMessageId)
      ));
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
    return original.call(this, options);
  };
  Object.defineProperty(prototype, MARKER, { value: true });
}
