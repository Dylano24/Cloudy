import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  buildTicketDashboardPayload,
  repostTicketPanel,
  saveTicketDashboardSetting,
  updateLiveTicketPanel,
} from '../../../services/ticketDashboardService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
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

  const recovered = await repostTicketPanel(client, guild);
  return recovered.config;
}

export default {
  name: 'ticket_dashboard_modal',

  async execute(interaction, client, args = []) {
    const [guildId, field] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    const canManage = interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels);
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

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      // Preserve the exact text submitted by the user. Do not trim, rewrite,
      // normalize punctuation, capitalization or spacing.
      const rawValue = interaction.fields.getTextInputValue('value');
      if (rawValue === null || rawValue === undefined || rawValue.length === 0) {
        const error = new Error('Ticket dashboard text value is empty.');
        error.userMessage = 'Enter a value before saving.';
        throw error;
      }

      let savedConfig = await saveTicketDashboardSetting(
        client,
        interaction.guild,
        field,
        rawValue,
      );

      savedConfig = await ensureLivePanel(client, interaction.guild, savedConfig);

      await InteractionHelper.safeEditReply(interaction, {
        content: field === 'ticketPanelMessage'
          ? '✅ The ticket panel message has been saved and updated.'
          : '✅ The ticket button label has been saved and updated.',
        embeds: [],
        components: [],
      });

      if (interaction.message?.edit) {
        await interaction.message.edit(
          buildTicketDashboardPayload(interaction.guild, savedConfig),
        ).catch(() => {});
      }
    } catch (error) {
      logger.error('Persistent ticket dashboard modal save failed', {
        guildId,
        field,
        userId: interaction.user?.id,
        error: error.message,
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'Could not save and update that ticket setting. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
