import { Events } from 'discord.js';
import { syncSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import {
  saveEmbedTemplateDecoration,
  saveGlobalEmbedTemplate,
} from '../services/embedTemplateService.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_KEY_PREFIX = 'cloudy template key:';
const TEMPLATE_CONTEXT_PREFIX = 'cloudy context:';
const ROULETTE_CONTEXT = 'gambling/roulette';
const ROULETTE_TEMPLATE_TITLES = new Map([
  ['embed:899476a8', 'Roulette — You lost'],
  ['embed:ff811637', 'Roulette — You won!'],
]);

const CONTEXT_CHANNEL_SLUGS = new Map([
  ['gambling', ['gambling']],
  ['tickets', ['ticket-logs', 'ticket-panel', 'tickets']],
  ['ban-appeal', ['ban-appeal', 'appeal']],
  ['reports', ['reports', 'report']],
  ['shop', ['shop', 'purchases']],
  ['music', ['music']],
  ['giveaway', ['giveaway']],
  ['welcome', ['welcome']],
  ['rules', ['rules']],
  ['faq', ['faq']],
  ['staff-reviews', ['staff-reviews', 'staff-review']],
  ['botlog', ['botlog', 'bot-logs']],
]);

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function templateMetadataIdentity(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const authorName = normalize(data.author?.name);
  return authorName.startsWith(TEMPLATE_KEY_PREFIX) ? authorName : null;
}

function templateContext(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const authorName = String(data.author?.name || '');
  const normalizedAuthor = authorName.toLowerCase();
  const contextIndex = normalizedAuthor.indexOf(TEMPLATE_CONTEXT_PREFIX);
  if (contextIndex === -1) return null;

  return normalize(
    authorName
      .slice(contextIndex + TEMPLATE_CONTEXT_PREFIX.length)
      .split('||')[0],
  ) || null;
}

function findContextChannel(guild, context) {
  const root = normalize(context).split('/')[0];
  const slugs = CONTEXT_CHANNEL_SLUGS.get(root) || [root];
  const normalizedSlugs = slugs.map(normalize).filter(Boolean);
  if (!normalizedSlugs.length) return null;

  const candidates = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(channel => channel?.isTextBased?.())
    .map(channel => {
      const channelName = normalize(channel.name);
      const parentName = normalize(channel.parent?.name);
      let score = 0;

      for (const slug of normalizedSlugs) {
        if (channelName === slug) score = Math.max(score, 100);
        else if (channelName.includes(slug)) score = Math.max(score, 80);
        else if (parentName === slug) score = Math.max(score, 60);
        else if (parentName.includes(slug)) score = Math.max(score, 40);
      }

      return { channel, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.channel.position ?? 0) - (b.channel.position ?? 0));

  return candidates[0]?.channel || null;
}

function rouletteCanonicalTitle(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const authorName = String(data.author?.name || '');
  const normalizedAuthor = authorName.toLowerCase();
  if (templateContext(data) !== ROULETTE_CONTEXT) return null;

  const prefixIndex = normalizedAuthor.indexOf(TEMPLATE_KEY_PREFIX);
  if (prefixIndex !== -1) {
    const rawKey = authorName
      .slice(prefixIndex + TEMPLATE_KEY_PREFIX.length)
      .split('||')[0]
      .trim()
      .toLowerCase();
    const canonical = ROULETTE_TEMPLATE_TITLES.get(rawKey);
    if (canonical) return canonical;
  }

  const title = String(data.title || '');
  if (/roulette\s*[—-]\s*you\s+lost/i.test(title)) return 'Roulette — You lost';
  if (/roulette\s*[—-]\s*you\s+won!?/i.test(title)) return 'Roulette — You won!';
  return null;
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message) return;

    // System-catalog embeds are displayed in their real feature channel by the
    // Embed Builder, but the backing message itself lives in the private catalog.
    // Stage the edited template against that real feature channel immediately,
    // before any DB/catalog synchronization, so the very next slash reply uses
    // the new title/color/logo/footer/media instead of the old command default.
    for (let index = 0; index < (message.embeds?.length || 0); index += 1) {
      const embed = message.embeds[index];
      const context = templateContext(embed);
      if (!context) continue;

      const scopeChannel = findContextChannel(message.guild, context);
      const data = embed.toJSON();
      const metadataIdentity = templateMetadataIdentity(data);
      const oldEmbed = metadataIdentity
        ? oldMessage?.embeds?.find(candidate => templateMetadataIdentity(candidate) === metadataIdentity)
        : oldMessage?.embeds?.[index];
      const oldData = oldEmbed?.toJSON?.() || {};
      const aliases = [oldData.title, data.title].filter(Boolean);
      const application = {
        applyFooter: Boolean(oldData.footer || data.footer),
        applyThumbnail: Boolean(oldData.thumbnail || data.thumbnail),
        applyImage: Boolean(oldData.image || data.image),
      };

      if (scopeChannel?.id) {
        void saveEmbedTemplateDecoration(
          message.guildId,
          scopeChannel.id,
          aliases,
          data,
          application,
        ).catch(error => {
          logger.warn(`Feature embed template persistence failed for ${context}: ${error.message}`);
        });
      }

      // Keep the existing roulette global fallback for slash replies that may be
      // invoked outside the dedicated gambling channel.
      const canonicalTitle = rouletteCanonicalTitle(embed);
      if (canonicalTitle) {
        void saveGlobalEmbedTemplate(
          message.guildId,
          [canonicalTitle, ...aliases],
          data,
          application,
        ).catch(error => {
          logger.warn(`Roulette embed template persistence failed: ${error.message}`);
        });
      }
    }

    await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`System embed catalog sync failed: ${error.message}`);
    });
  },
};
