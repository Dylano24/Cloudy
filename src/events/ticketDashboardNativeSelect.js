import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    const isNativeTicketSelect = Boolean(
      (interaction.isChannelSelectMenu?.() || interaction.isRoleSelectMenu?.())
      && interaction.customId?.startsWith('ticket_dashboard_value:')
    );

    if (!isNativeTicketSelect) return;

    const [customId, ...args] = interaction.customId.split(':');
    const handler = client.selectMenus.get(customId);

    if (!handler?.execute) {
      logger.error('Native ticket dashboard select handler is missing', {
        customId: interaction.customId,
        guildId: interaction.guildId,
      });

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'This ticket setting is temporarily unavailable. Please reopen `/ticket dashboard` and try again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return;
    }

    try {
      await handler.execute(interaction, client, args);
    } catch (error) {
      logger.error('Native ticket dashboard select failed', {
        customId: interaction.customId,
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        error: error.message,
      });

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: error?.userMessage || 'Could not save that ticket setting. Please try again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }
  },
};
