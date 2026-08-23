import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  repostTicketPanel,
  updateLiveTicketPanel,
} from '../../../services/ticketDashboardService.js';
import { updateGuildConfig } from '../../../services/config/guildConfig.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import {
  buildCloudyTicketEmbed,
  scheduleTicketReplyDeletion,
} from '../../../utils/ticket/ticketBranding.js';
import { logger } from '../../../utils/logger.js';

const ALLOWED_TEXT_FIELDS = new Set(['ticketPanelMessage', 'ticketButtonLabel']);

async function ensureLivePanel(client, guild, config) {
  try {
    const updated = await updateLiveTicketPanel(client, guild, config);
    if (updated) return config;
  } catch (error) {
    logger.warn('Live ticket panel edit failed; recreating panel', {
      guildId: guild.id,
      error: error.message,
    });
  }

  if (!config.ticketPanelChannelId) return config;
  const recovered = await repostTicketPanel(client, guild);
  return recovered.config;
}

async function refreshDashboardMessage(interaction, dashboardMessageId, config) {
  if (!dashboardMessageId) return false;

  const channel = interaction.channel;
  if (!channel?.messages?.fetch) return false;

  const dashboardMessage = await channel.messages.fetch(dashboardMessageId).catch(() => null);
  if (!dashboardMessage?.edit) return false;

  await dashboardMessage.edit(
    buildTicketDashboardPayload(interaction.guild, config),
  );
  return true;
}

export default {
  name: 'ticket_dashboard_modal',

  async execute(interaction, client, args = []) {
    const [guildId, field, dashboardMessageId] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
    if (!canManage) {
      await InteractionHelper.safeReply(interaction, {
        content: 'You need the `Manage Channels` permission to change ticket-system settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!ALLOWED_TEXT_FIELDS.has(field)) {
      await InteractionHelper.safeReply(interaction, {
        content: 'That ticket setting cannot be changed.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.reply({
        content: 'Saving ticket setting…',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Ticket dashboard modal could not be acknowledged', {
        guildId,
        field,
        error: error.message,
      });
      return;
    }

    try {
      const rawValue = interaction.fields.getTextInputValue('value');
      if (rawValue === null || rawValue === undefined || rawValue.length === 0) {
        const error = new Error('Ticket dashboard text value is empty.');
        error.userMessage = 'Enter a value before saving.';
        throw error;
      }

      // Persist first and return the fresh config immediately. Do not block the
      // dashboard response on Discord message lookups/edits for the live panel.
      const savedConfig = await updateGuildConfig(client, guildId, {
        [field]: rawValue,
        dmOnClose: false,
      });

      // A modal submit does not reliably expose interaction.message. The source
      // dashboard message ID is encoded in the modal custom ID, so fetch and
      // refresh that exact message instead. This makes the new value visible
      // immediately without reopening the dashboard or restarting the bot.
      await refreshDashboardMessage(interaction, dashboardMessageId, savedConfig).catch(error => {
        logger.warn('Ticket dashboard source message refresh failed', {
          guildId,
          field,
          dashboardMessageId,
          error: error.message,
        });
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [buildCloudyTicketEmbed({
          title: 'Ticket Setting Updated',
          description: field === 'ticketPanelMessage'
            ? 'The ticket panel message has been saved.'
            : 'The ticket button label has been saved.',
        })],
        components: [],
      });
      scheduleTicketReplyDeletion(interaction);

      // Keep the live public ticket panel synchronized, but do that after the
      // administrator already received the successful save response.
      void ensureLivePanel(client, interaction.guild, savedConfig).catch(error => {
        logger.error('Background live ticket panel sync failed', {
          guildId,
          field,
          error: error.message,
        });
      });
    } catch (error) {
      logger.error('Persistent ticket dashboard modal save failed', {
        guildId,
        field,
        userId: interaction.user?.id,
        error: error.message,
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'Could not save that ticket setting. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
