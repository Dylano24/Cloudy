import { AUTOMOD_LOG_CHANNEL_ID, isBotActionFeedback, resolveMessageDeleter } from '../services/deletionAttributionService.js';
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

function embedSummary(embeds = []) {
  return embeds.map(embed => [embed.title, embed.description, ...(embed.fields || []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n\n');
}

export async function logDeletedMessage(message, options = {}) {
  if (!message.guild) return;
  const guildId = message.guild.id;
  const channelId = message.channelId || message.channel?.id || null;
  if ([OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID].includes(channelId) || isBotActionFeedback(message)) return;
  const detectedAt = options.detectedAt ?? Date.now();

  // An uncached (partial) message has no author/content. Use the copy
  // Cloudy stored when the message was sent or last edited.
  const uncached = message.partial || !message.author;
  const snapshot = !uncached ? null
    : options.snapshot !== undefined ? options.snapshot : await getMessageSnapshot(guildId, message.id);
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

  const files = [...media.files];
  if (fullBody.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH || media.links.length) {
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
      userId: resolvedAuthorId,
      authorBot,
      deletedById: deletedBy.id,
      deletionSource: deletedBy.source,
      channelId,
    }
  });
  if (snapshot || !uncached) await forgetMessageSnapshot(guildId, message.id);
}
