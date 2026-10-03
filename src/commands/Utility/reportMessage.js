import {
  ActionRowBuilder,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { resolveUserAuthor } from '../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

const REPORT_MODAL_TIMEOUT_MS = 14 * 60_000;

function reportEvidence(message) {
  const parts = [
    `Message: [Open reported message](${message.url})`,
    `Channel: ${message.channel}`,
  ];

  const content = String(message.content || '').trim();
  if (content) {
    const available = Math.max(0, 1024 - parts.join('\n').length - 20);
    parts.push(`Content: ${content.slice(0, available)}`);
  } else {
    parts.push('Content: No text content');
  }

  if (message.attachments?.size) {
    parts.push(`Attachments: ${message.attachments.size}`);
  }

  return parts.join('\n').slice(0, 1024);
}

export default {
  data: new ContextMenuCommandBuilder()
    .setName('Cloudy report')
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false),
  category: 'Utility',
  adminOnly: false,
  abuseProtection: { maxAttempts: 5, windowMs: 60_000 },

  async execute(interaction, config, client) {
    const message = interaction.targetMessage;
    if (!message?.id || !message.author?.id) return;

    const modalId = `cloudy_report:${interaction.id}:${message.id}`.slice(0, 100);
    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason')
      .setPlaceholder('What happened?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(1000);

    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Cloudy report')
      .addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
      time: REPORT_MODAL_TIMEOUT_MS,
      filter: modalInteraction =>
        modalInteraction.customId === modalId
        && modalInteraction.user?.id === interaction.user?.id,
    }).catch(() => null);

    if (!submitted) return;

    await InteractionHelper.safeDefer(submitted, { flags: MessageFlags.Ephemeral });
    const reason = submitted.fields.getTextInputValue('reason').trim();

    const attachments = [...message.attachments.values()]
      .slice(0, 10)
      .map(attachment => ({
        attachment: attachment.url,
        name: attachment.name || 'reported-attachment',
      }));

    await logEvent({
      client,
      guildId: interaction.guildId,
      eventType: EVENT_TYPES.REPORT_FILE,
      attachments,
      data: {
        title: 'New report',
        blockFields: [
          {
            name: 'Reported member',
            value: `<@${message.author.id}>`,
          },
          {
            name: 'Reported by',
            value: `<@${interaction.user.id}>`,
          },
          {
            name: 'Reason',
            value: reason.slice(0, 1024),
          },
          {
            name: 'Evidence',
            value: reportEvidence(message),
          },
          {
            name: 'Submitted',
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          },
        ],
        author: await resolveUserAuthor(client, message.author.id),
        thumbnail: message.author.displayAvatarURL({ size: 256 }),
      },
    });

    await InteractionHelper.safeEditReply(submitted, {
      embeds: [createEmbed({
        title: 'Report submitted',
        description: 'Your report has been sent to the staff team. Staff will review it as soon as possible.',
        color: 'success',
      })],
    });

    logger.info('Cloudy message report submitted', {
      guildId: interaction.guildId,
      reporterId: interaction.user.id,
      reportedUserId: message.author.id,
      channelId: message.channelId,
      messageId: message.id,
    });
  },
};
