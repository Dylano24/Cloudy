import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

export default {
  data: new ContextMenuCommandBuilder()
    .setName('reports')
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false),
  category: 'Utility',
  adminOnly: false,
  abuseProtection: { maxAttempts: 5, windowMs: 60_000 },

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

    const message = interaction.targetMessage;
    const attachments = [...message.attachments.values()]
      .slice(0, 10)
      .map(attachment => ({
        attachment: attachment.url,
        name: attachment.name || 'reported-attachment',
      }));

    const blockFields = [];
    if (message.content) {
      blockFields.push({
        name: 'Reported Message',
        value: message.content.slice(0, 1024),
      });
    }
    if (attachments.length > 0) {
      blockFields.push({
        name: 'Picture / Evidence',
        value: `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} included below.`,
      });
    }

    await logEvent({
      client,
      guildId: interaction.guildId,
      eventType: EVENT_TYPES.REPORT_FILE,
      content: interaction.guild.ownerId
        ? `<@${interaction.guild.ownerId}> New message report!`
        : 'New message report!',
      attachments,
      data: {
        title: 'Message / Picture Report',
        lines: [
          formatLogLine('Reported User', `${message.author.tag} (\`${message.author.id}\`)`),
          formatLogLine('Reported By', `${interaction.user.tag} (\`${interaction.user.id}\`)`),
          formatLogLine('Channel', message.channel.toString()),
          formatLogLine('Message Link', message.url),
          formatLogLine('Reported At', `<t:${Math.floor(Date.now() / 1000)}:F>`),
        ],
        blockFields,
        author: await resolveUserAuthor(client, message.author.id),
        thumbnail: message.author.displayAvatarURL({ size: 256 }),
      },
    });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [createEmbed({
        title: 'Report Submitted',
        description: 'The message and its attachments were sent to the moderation team.',
        color: 'success',
      })],
    });

    logger.info('Message context report submitted', {
      guildId: interaction.guildId,
      reporterId: interaction.user.id,
      reportedUserId: message.author.id,
      messageId: message.id,
    });
  },
};
