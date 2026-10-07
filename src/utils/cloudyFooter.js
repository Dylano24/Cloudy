import { REST } from '@discordjs/rest';
import { isCloudyLogoUrl } from '../services/cloudyLogoService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER, isMentionOnlyContent } from '../services/cloudyBrandingService.js';

export { isMentionOnlyContent } from '../services/cloudyBrandingService.js';

export const CLOUDY_STANDARD_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const MARKER = Symbol.for('cloudy.standard-footer-output');
const DEFERRED_REPLY_TTL_MS = 15 * 60_000;
const deferredReplyTokens = new Map();

function addFooterEmbed(payload) {
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  if (embeds.length >= 10) return payload;
  return { ...payload, embeds: [...embeds, { footer: { text: CLOUDY_STANDARD_FOOTER } }] };
}

export function withCloudyFooter(payload, { isNewMessage = true } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Number(payload.flags) & 32768) return payload;
  // Recipient tags are companion text, not a separate branded message.
  if (isMentionOnlyContent(payload.content)) return payload;
  if (Array.isArray(payload.embeds) && payload.embeds.length) {
    const data = payload.embeds.map(embed => ({ ...(embed?.toJSON?.() || embed || {}) }));
    let permissionPresentationChanged = false;
    for (const embed of data) {
      if (embed.description === 'Only owners can ban members from reports.') {
        embed.title = 'Permission denied';
        embed.thumbnail = { url: CLOUDY_C_LOGO_URL };
        permissionPresentationChanged = true;
      }
    }
    const messageAlreadyBranded = data.some(embed => {
      const title = String(embed.title || '').trim();
      const isGuideException = /\bZORP Guide\s*$/i.test(title);
      const hasBuilderOptOut = embed.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER);
      const hasCloudyLogo = isCloudyLogoUrl(embed.thumbnail?.url)
        || isCloudyLogoUrl(embed.author?.icon_url || embed.author?.iconURL)
        || isCloudyLogoUrl(embed.footer?.icon_url || embed.footer?.iconURL);
      const alreadyHasFooter = Boolean(embed.footer?.text || embed.footer?.icon_url || embed.footer?.iconURL);
      return isGuideException || hasBuilderOptOut || hasCloudyLogo || alreadyHasFooter;
    });

    if (messageAlreadyBranded) return permissionPresentationChanged ? { ...payload, embeds: data } : payload;

    const firstRichEmbed = data.findIndex(embed => !embed.type || embed.type === 'rich');
    if (firstRichEmbed >= 0) {
      const embeds = [...payload.embeds];
      embeds[firstRichEmbed] = { ...data[firstRichEmbed], footer: { text: CLOUDY_STANDARD_FOOTER } };
      return { ...payload, embeds };
    }
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

// The standard EmbedBuilder#setFooter policy filters non-essential footer text,
// while logo-branded messages skip the global auto-footer. Report submission
// confirmations explicitly require this footer, without changing other embeds
// or overwriting a custom footer saved in the Embed Builder.
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
        }),
      };
    } else if (isCallback && [4, 7].includes(options.body?.type)) {
      options = {
        ...options,
        body: {
          ...options.body,
          data: withCloudyFooter(options.body.data, { isNewMessage: options.body.type === 4 }),
        },
      };
    }
    return original.call(this, options);
  };
  Object.defineProperty(prototype, MARKER, { value: true });
}
