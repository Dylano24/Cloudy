import { AUTOMOD_LOG_CHANNEL_ID, isBotActionFeedback, resolveMessageDeleter } from '../services/deletionAttributionService.js';
import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getReactionRoleMessage, deleteReactionRoleMessage } from '../services/reactionRoleService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { removeEmbedRegistryMessage } from '../services/embedRegistryService.js';
import { OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID } from '../services/messageLogDestination.js';
import { prepareDeletedMessageMedia } from '../services/deletedMessageMediaService.js';

const MAX_LOGGED_MESSAGE_CONTENT_LENGTH = 1024;

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    try {
      if (!message.guild) return;

      const mayBeRegisteredEmbed = message.partial
        || !message.author
        || message.author.id === message.client.user?.id;
      if (mayBeRegisteredEmbed) {
        await removeEmbedRegistryMessage(message.guild.id, message.channelId, message.id)
          .catch(error => logger.warn(`Failed to remove deleted message ${message.id} from the embed registry:`, error));
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
                  formatLogLine('Channel', message.channel ? `${message.channel.name} ${message.channel.toString()}` : 'Unknown'),
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

      await logDeletedMessage(message);

    } catch (error) {
      logger.error('Error in messageDelete event:', error);
    }
  }
};

export async function logDeletedMessage(message, options = {}) {
  if (!message.guild) return;
  if ([OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID].includes(message.channelId) || isBotActionFeedback(message)) return;
  const deletedBy = await resolveMessageDeleter(message, options);
  const media = await prepareDeletedMessageMedia(message);

  const metaLines = [
    formatLogLine('Deleted by', deletedBy.label),
    formatLogLine('Channel', message.channel ? `${message.channel.name} ${message.channel.toString()}` : 'Unknown'),
    formatLogLine('Message ID', `\`${message.id}\``),
    formatLogLine('Message author', message.author ? message.author.toString() : 'Unknown'),
    formatLogLine('Message created', Number.isFinite(message.createdTimestamp) ? `<t:${Math.floor(message.createdTimestamp / 1000)}:R>` : 'Unknown'),
  ];

  let messageBody = null;
  let fullBody = message.content || '';
  if (message.content) {
    messageBody = message.content.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH
      ? `${message.content.substring(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH - 3)}...`
      : message.content;
  }

  if (!messageBody && message.embeds?.length) {
    fullBody = message.embeds.map(embed => [embed.title, embed.description, ...(embed.fields || []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n\n');
    messageBody = fullBody.slice(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH);
  }
  if (!messageBody && message.partial) messageBody = 'Message content was not cached before deletion.';

  if (message.attachments?.size > 0) {
    metaLines.push(formatLogLine('Attachments', String(message.attachments.size)));
    if (media.links.length) fullBody += `\n\nAttachments not copied:\n${media.links.join('\n')}`;
  }

  const files = [...media.files];
  if (fullBody.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH || media.links.length) {
    files.push({ attachment: Buffer.from(fullBody), name: `deleted-message-${message.id}.txt` });
  }

  await logEvent({
    client: message.client,
    guildId: message.guild.id,
    eventType: EVENT_TYPES.MESSAGE_DELETE,
    attachments: files,
    data: {
      title: 'Message deleted',
      attachmentFallback: [...message.attachments?.values?.() || []].map(attachment => attachment.url).filter(Boolean).join('\n'),
      lines: metaLines,
      quoted: true,
      section: messageBody ? { title: 'Message', body: messageBody || '*(empty message)*' } : null,
      userId: message.author?.id,
      authorBot: message.author?.bot === true,
      deletedById: deletedBy.id,
      deletionSource: deletedBy.source,
      channelId: message.channelId || message.channel?.id,
    }
  });
}
