import { AUTOMOD_LOG_CHANNEL_ID, isBotActionFeedback, isCloudyInteractionMessage, resolveMessageDeleter, wasDeletedForMove } from '../services/deletionAttributionService.js';
import { Events, SnowflakeUtil } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getReactionRoleMessage, deleteReactionRoleMessage } from '../services/reactionRoleService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { removeEmbedRegistryMessage } from '../services/embedRegistryService.js';
import { OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID } from '../services/messageLogDestination.js';
import { prepareDeletedMessageMedia } from '../services/deletedMessageMediaService.js';
import { removeSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import { forgetMessageSnapshot, getMessageSnapshot } from '../services/messageSnapshotService.js';
import { storeDeletedVideo } from '../services/deletedMediaService.js';

// The log description holds up to 4096 characters; keep room for the
// header lines. Longer text is attached in full as a .txt file.
const MAX_LOGGED_MESSAGE_CONTENT_LENGTH = 3500;

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    const detectedAt = Date.now();
    try {
      if (!message.guild) return;

      // The log does not depend on the cleanup below; start it at once so
      // registry/database work never delays the deletion log.
      const logging = logDeletedMessage(message, { detectedAt })
        .catch(error => logger.error('Error logging deleted message:', error));

      const mayBeRegisteredEmbed = message.partial
        || !message.author
        || message.author.id === message.client.user?.id;
      if (mayBeRegisteredEmbed) {
        await Promise.all([
          removeEmbedRegistryMessage(message.guild.id, message.channelId, message.id)
            .catch(error => logger.warn(`Failed to remove deleted message ${message.id} from the embed registry:`, error)),
          removeSystemEmbedCatalogMessage(message.guild.id, message.channelId, message.id)
            .catch(error => logger.warn(`Failed to invalidate deleted system catalog message ${message.id}:`, error)),
        ]);
      }

      try {
        const reactionRoleData = await getReactionRoleMessage(message.client, message.guild.id, message.id);
        if (reactionRoleData) {
          await deleteReactionRoleMessage(message.client, message.guild.id, message.id);
          logger.info(`Cleaned up reaction role database entry for manually deleted message ${message.id} in guild ${message.guild.id}`);

          try {
            await logEvent({
              client: message.client,
              guildId: message.guild.id,
              eventType: EVENT_TYPES.REACTION_ROLE_DELETE,
              data: {
                title: 'Reaction Role Removed',
                lines: [
                  formatLogLine('Channel', channelMention(message.channelId || message.channel?.id)),
                  formatLogLine('Message ID', `\`${message.id}\``),
                  formatLogLine('Cleanup', 'Database entry removed automatically'),
                ],
                quoted: true,
              }
            });
          } catch (logCleanupError) {
            logger.warn('Failed to log reaction role cleanup after manual message deletion:', logCleanupError);
          }
        }
      } catch (reactionRoleCleanupError) {
        logger.warn(`Failed to clean up reaction role data for deleted message ${message.id}:`, reactionRoleCleanupError);
      }

      await logging;

    } catch (error) {
      logger.error('Error in messageDelete event:', error);
    }
  }
};

function channelMention(channelId) {
  return channelId ? `<#${channelId}>` : 'Unknown';
}

function createdTimestamp(message, snapshot) {
  const known = Number(message.createdTimestamp) || Number(snapshot?.createdTimestamp);
  if (Number.isFinite(known) && known > 0) return known;
  // A message ID is a Discord snowflake: it always contains its creation time.
  try {
    return /^\d{17,20}$/.test(String(message.id)) ? SnowflakeUtil.timestampFrom(String(message.id)) : null;
  } catch {
    return null;
  }
}

function attachmentList(message, snapshot) {
  const live = [...(message.attachments?.values?.() || [])];
  if (live.length || !snapshot?.attachments?.length) return live;
  return snapshot.attachments;
}

// Discord allows 6000 characters across all embeds of one message; keep room
// for the log details above the copied embed.
const MAX_EMBED_COPY_CHARS = 4500;
const COPIED_EMBED_LIMIT = 9;
const UPLOAD_BATCH_SIZE = 10;

function copiedEmbedLength(embed) {
  return [embed.title, embed.description, embed.author?.name, embed.footer?.text,
    ...(embed.fields || []).flatMap(field => [field.name, field.value])]
    .reduce((total, value) => total + String(value || '').length, 0);
}

/**
 * The deleted embeds themselves (colour bar, banner, thumbnail, fields,
 * footer), for a log that shows them under its details. Buttons are not
 * copied. An image that was an attachment of the deleted message points to
 * its copy uploaded with the log. Empty when they would not fit.
 */
export function deletedEmbedCopies(message, attachments = [], files = []) {
  const uploaded = new Set(files.slice(0, UPLOAD_BATCH_SIZE).map(file => String(file.name)));
  const viaUpload = url => {
    if (!url) return undefined;
    const path = String(url).split('?')[0];
    const source = attachments.find(attachment => (attachment.id && path.includes(`/${attachment.id}/`))
      || [attachment.url, attachment.proxyURL].filter(Boolean).some(value => String(value).split('?')[0] === path));
    if (!source) return url;
    const name = [String(source.name || ''), String(source.name || '').replace(/[^\w.-]/g, '_')]
      .find(candidate => uploaded.has(candidate));
    return name ? `attachment://${name}` : url;
  };
  const copies = [];
  for (const embed of message.embeds || []) {
    if (copies.length >= COPIED_EMBED_LIMIT) break;
    const data = embed?.toJSON?.() || embed?.data || embed || {};
    if (data.type && data.type !== 'rich') continue;
    const copy = {};
    for (const key of ['title', 'description', 'url', 'color', 'timestamp']) {
      if (data[key] != null && data[key] !== '') copy[key] = data[key];
    }
    if (data.author?.name) {
      copy.author = { name: data.author.name, url: data.author.url || undefined, icon_url: viaUpload(data.author.icon_url) };
    }
    // The Builder's invisible footer marker identifies its own posts; a log
    // copy must never look like one.
    const footerText = String(data.footer?.text || '').replace(/\u200B+$/u, '');
    if (footerText) copy.footer = { text: footerText, icon_url: viaUpload(data.footer.icon_url) };
    if (data.fields?.length) copy.fields = data.fields.map(({ name, value, inline }) => ({ name, value, inline: Boolean(inline) }));
    if (data.image?.url) copy.image = { url: viaUpload(data.image.url) };
    if (data.thumbnail?.url) copy.thumbnail = { url: viaUpload(data.thumbnail.url) };
    if (copy.title || copy.description || copy.fields || copy.image || copy.thumbnail || copy.author || copy.footer) copies.push(copy);
  }
  const total = copies.reduce((sum, copy) => sum + copiedEmbedLength(copy), 0);
  return total <= MAX_EMBED_COPY_CHARS ? copies : [];
}

function embedSummary(embeds = []) {
  return embeds.map(embed => [embed.title, embed.description, ...(embed.fields || []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n\n');
}

export async function logDeletedMessage(message, options = {}) {
  if (!message.guild) return;
  const guildId = message.guild.id;
  const channelId = message.channelId || message.channel?.id || null;
  if ([OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID].includes(channelId)) return;
  const detectedAt = options.detectedAt ?? Date.now();
  // Reappear and sticky guides delete the old copy to move it to the bottom:
  // that is not a removal, so it is not logged. Cloudy's own replies to an
  // action (status, command and button replies) are not logged either.
  // Cloudy's private replies are known by ID only: they were never cached.
  if (isBotActionFeedback(message) || isCloudyInteractionMessage(message.id)
    || await wasDeletedForMove(message.id)) {
    await forgetMessageSnapshot(guildId, message.id);
    return;
  }

  // An uncached (partial) message has no author/content. Use the copy
  // Cloudy stored when the message was sent or last edited.
  const uncached = message.partial || !message.author;
  const snapshot = !uncached ? null
    : options.snapshot !== undefined ? options.snapshot : await getMessageSnapshot(guildId, message.id);
  if (snapshot?.feedback) {
    await forgetMessageSnapshot(guildId, message.id);
    return;
  }
  const authorId = message.author?.id || snapshot?.authorId || null;
  const authorBot = message.author ? message.author.bot === true : snapshot?.authorBot === true;
  const attachments = attachmentList(message, snapshot);

  const [deletedBy, media] = await Promise.all([
    options.deletedBy || resolveMessageDeleter(message, { bulk: options.bulk === true, authorId, authorBot, detectedAt }),
    prepareDeletedMessageMedia({ attachments: new Map(attachments.map((attachment, index) => [attachment.id || String(index), attachment])) }),
  ]);
  // With neither cache nor snapshot, the matching audit entry names the author.
  const resolvedAuthorId = authorId || deletedBy.authorId || null;
  const created = createdTimestamp(message, snapshot);

  const metaLines = [
    formatLogLine('Deleted by', deletedBy.label),
    formatLogLine('Channel', channelMention(channelId)),
    formatLogLine('Message ID', `\`${message.id}\``),
    formatLogLine('Message author', resolvedAuthorId ? `<@${resolvedAuthorId}>` : 'Unknown'),
    formatLogLine('Message created', created ? `<t:${Math.floor(created / 1000)}:f>` : 'Unknown'),
  ];

  const content = message.content || (uncached ? snapshot?.content : '') || '';
  let fullBody = content || embedSummary(message.embeds || []) || (uncached ? snapshot?.embedText : '') || '';
  const stickers = [...(message.stickers?.values?.() || [])].map(sticker => sticker.name).filter(Boolean);
  const stickerNames = stickers.length ? stickers : (uncached ? snapshot?.stickers || [] : []);
  if (stickerNames.length) fullBody = [fullBody, `Stickers: ${stickerNames.join(', ')}`].filter(Boolean).join('\n\n');

  let messageBody = fullBody
    ? (fullBody.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH
      ? `${fullBody.substring(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH - 3)}...`
      : fullBody)
    : null;
  if (!messageBody && uncached && !snapshot && !attachments.length) {
    messageBody = 'Content unavailable: this message was not cached before deletion.';
  }

  // "Message created" stays the last header line; attachment names belong
  // to the message itself.
  if (attachments.length > 0) {
    const names = attachments.map(attachment => attachment.name).filter(Boolean).join(', ');
    const summary = formatLogLine('Attachments', names ? `${attachments.length} (${names})`.slice(0, 300) : String(attachments.length));
    messageBody = messageBody ? `${messageBody}\n\n${summary}` : summary;
    if (media.links.length) fullBody += `\n\nAttachments not copied:\n${media.links.join('\n')}`;
  }

  let files = [...media.files];
  // Videos cannot play inside a bot embed. Host them on Cloudy's own page
  // and link that page in the log instead of uploading them to Discord.
  const videoLinks = [];
  for (const video of media.videos || []) {
    const file = files.find(entry => entry.name === video.name);
    if (!file) continue;
    const url = await storeDeletedVideo(file.attachment, { name: video.name, contentType: video.type })
      .catch(error => { logger.warn(`Deleted video could not be stored: ${error.message}`); return null; });
    if (!url) continue;
    videoLinks.push({ name: video.name, url });
    files = files.filter(entry => entry !== file);
  }
  // An Embed Builder Delete shows the deleted embed itself (colour bar,
  // banner, fields) under the log details instead of its text.
  const embedCopies = deletedBy.source === 'embed-builder' && !uncached
    ? deletedEmbedCopies(message, attachments, files) : [];
  if (embedCopies.length) messageBody = null;
  // The first photo is shown inside the embed (clickable there). It must be
  // in the first upload batch of 10, which carries the embed.
  const embedImage = embedCopies.length ? null : (media.images || []).find(name => {
    const index = files.findIndex(file => file.name === name);
    return index >= 0 && index < 10;
  });
  if ((!embedCopies.length && fullBody.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH) || media.links.length) {
    files.push({ attachment: Buffer.from(fullBody), name: `deleted-message-${message.id}.txt` });
  }

  await logEvent({
    client: message.client,
    guildId,
    eventType: EVENT_TYPES.MESSAGE_DELETE,
    attachments: files,
    data: {
      title: 'Message deleted',
      attachmentFallback: attachments.map(attachment => attachment.url).filter(Boolean).join('\n'),
      lines: metaLines,
      quoted: true,
      section: messageBody ? { title: 'Message', body: messageBody } : null,
      image: embedImage ? `attachment://${embedImage}` : null,
      userId: resolvedAuthorId,
      authorBot,
      deletedById: deletedBy.id,
      deletedByBot: deletedBy.bot === true,
      deletionSource: deletedBy.source,
      videoLinks,
      embedCopies,
      channelId,
    }
  });
  if (snapshot || !uncached) await forgetMessageSnapshot(guildId, message.id);
}
