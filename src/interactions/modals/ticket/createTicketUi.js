import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { createTicket } from '../../../services/ticketUiService.js';

export default {
  name: 'create_ticket_modal',

  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;

      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;

      const { channel } = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
      );

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Created', `Your ticket has been created in ${channel}!`)],
      });
    } catch (error) {
      await handleInteractionError(interaction, error, {
        type: 'modal',
        handler: 'ticket',
        customId: interaction.customId,
      });
    }
  },
};
