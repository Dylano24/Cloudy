import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { getReactionRoleMessage, deleteReactionRoleMessage } from '../services/reactionRoleService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { removeEmbedRegistryMessage } from '../services/embedRegistryService.js';
import { OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID } from '../services/messageLogDestination.js';

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

export async function logDeletedMessage(message) {
  if (!message.guild) return;
  if ([OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID].includes(message.channelId)) return;

  const metaLines = [
    formatLogLine('Channel', message.channel ? `${message.channel.name} ${message.channel.toString()}` : 'Unknown'),
    formatLogLine('Message ID', `\`${message.id}\``),
    formatLogLine('Message author', message.author ? message.author.toString() : 'Unknown'),
    formatLogLine('Message created', Number.isFinite(message.createdTimestamp) ? `<t:${Math.floor(message.createdTimestamp / 1000)}:R>` : 'Unknown'),
  ];

  metaLines.push(formatLogLine('Author type', message.author?.bot ? 'Bot' : message.author ? 'Member' : 'Unknown'));
  let messageBody = null;
  if (message.content) {
    messageBody = message.content.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH
      ? `${message.content.substring(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH - 3)}...`
      : message.content;
  }

  if (!messageBody && message.embeds?.length) {
    messageBody = message.embeds.map(embed => [embed.title, embed.description, ...(embed.fields || []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n\n').slice(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH);
  }
  if (!messageBody && message.partial) messageBody = 'Message content was not cached before deletion.';

  if (message.attachments?.size > 0) {
    metaLines.push(formatLogLine('Attachments', String(message.attachments.size)));
  }

  await logEvent({
    client: message.client,
    guildId: message.guild.id,
    eventType: EVENT_TYPES.MESSAGE_DELETE,
    data: {
      title: 'Message deleted',
      lines: metaLines,
      quoted: true,
      section: messageBody ? { title: 'Message', body: messageBody || '*(empty message)*' } : null,
      userId: message.author?.id,
      authorBot: message.author?.bot === true,
      channelId: message.channelId || message.channel?.id,
    }
  });
}
