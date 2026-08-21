import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  TICKET_DASHBOARD_CLEAR_VALUE,
  buildTicketDashboardPayload,
  buildTicketDashboardValuePrompt,
  getCurrentTicketDashboardConfig,
  moveTicketPanel,
  saveTicketDashboardSetting,
} from '../../../services/ticketDashboardService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

function canManageTickets(interaction) {
  return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
}

async function rejectUnauthorized(interaction) {
  const payload = {
    content: 'You need the `Manage Channels` permission to change ticket-system settings.',
    embeds: [],
    components: [],
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    await InteractionHelper.safeEditReply(interaction, payload);
  } else {
    await InteractionHelper.safeReply(interaction, payload);
  }
}

function buildTextSettingModal(interaction, guildId, setting, config) {
  const isPanelMessage = setting === 'panel_message';
  const field = isPanelMessage ? 'ticketPanelMessage' : 'ticketButtonLabel';
  const modal = new ModalBuilder()
    .setCustomId(`ticket_dashboard_modal:${guildId}:${field}:${interaction.message.id}`)
    .setTitle(isPanelMessage ? 'Edit Panel Message' : 'Edit Button Label');

  const currentValue = isPanelMessage
    ? (config.ticketPanelMessage || '')
    : (config.ticketButtonLabel || 'Start Chat');

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(isPanelMessage ? 'Panel message' : 'Button label')
    .setStyle(isPanelMessage ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(isPanelMessage ? 2000 : 80)
    .setValue(String(currentValue).slice(0, isPanelMessage ? 2000 : 80));

  if (isPanelMessage) {
    input.setPlaceholder('Enter the support panel message...');
  } else {
    input.setPlaceholder('Start Chat');
  }

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

const dashboardSelectHandler = {
  name: 'ticket_dashboard_select',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    if (!canManageTickets(interaction)) {
      await rejectUnauthorized(interaction);
      return;
    }

    try {
      const setting = interaction.values?.[0];
      const config = await getCurrentTicketDashboardConfig(client, guildId);

      if (setting === 'panel_message' || setting === 'button_label') {
        await interaction.showModal(buildTextSettingModal(interaction, guildId, setting, config));
        return;
      }

      const prompt = buildTicketDashboardValuePrompt(interaction.guild, setting, config);
      if (!prompt) {
        await interaction.update(buildTicketDashboardPayload(interaction.guild, config));
        return;
      }

      await interaction.update(prompt);
    } catch (error) {
      logger.error('Persistent ticket dashboard select failed', {
        guildId,
        userId: interaction.user?.id,
        error: error.message,
      });

      if (!interaction.replied && !interaction.deferred) {
        await InteractionHelper.safeReply(interaction, {
          content: error?.userMessage || 'Could not open that ticket setting. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

const dashboardValueHandler = {
  name: 'ticket_dashboard_value',

  async execute(interaction, client, args = []) {
    const [guildId, field] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    if (!canManageTickets(interaction)) {
      await rejectUnauthorized(interaction);
      return;
    }

    try {
      await interaction.deferUpdate();

      const rawValue = interaction.values?.[0];
      let savedConfig;

      if (field === 'ticketPanelChannelId') {
        if (rawValue === TICKET_DASHBOARD_CLEAR_VALUE) {
          const error = new Error('Panel channel cannot be cleared while the ticket system is active.');
          error.userMessage = 'Choose another panel channel, or use **Delete System** if you want to remove the ticket system.';
          throw error;
        }
        savedConfig = await moveTicketPanel(client, interaction.guild, rawValue);
      } else if (field === 'maxTicketsPerUser') {
        const value = Number.parseInt(rawValue, 10);
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          throw new Error('Invalid max tickets value.');
        }
        savedConfig = await saveTicketDashboardSetting(client, interaction.guild, field, value);
      } else {
        const value = rawValue === TICKET_DASHBOARD_CLEAR_VALUE ? null : rawValue;
        savedConfig = await saveTicketDashboardSetting(client, interaction.guild, field, value);
      }

      await interaction.editReply(buildTicketDashboardPayload(interaction.guild, savedConfig));
    } catch (error) {
      logger.error('Persistent ticket dashboard value save failed', {
        guildId,
        field,
        userId: interaction.user?.id,
        error: error.message,
      });

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not save that ticket setting. Please try again.';

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await InteractionHelper.safeReply(interaction, {
          content: payload.content,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

export default [dashboardSelectHandler, dashboardValueHandler];
