import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  buildTicketDashboardPayload,
  buildTicketDashboardValuePrompt,
  deleteTicketSystem,
  getCurrentTicketDashboardConfig,
  repostTicketPanel,
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

async function validateDashboardInteraction(interaction, guildId) {
  if (!interaction.inGuild() || guildId !== interaction.guildId) return false;
  if (!canManageTickets(interaction)) {
    await rejectUnauthorized(interaction);
    return false;
  }
  return true;
}

const backHandler = {
  name: 'ticket_dashboard_back',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    await interaction.deferUpdate();
    const config = await getCurrentTicketDashboardConfig(client, guildId);
    await interaction.editReply(buildTicketDashboardPayload(interaction.guild, config));
  },
};

const staffHandler = {
  name: 'ticket_dashboard_staff',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    try {
      await interaction.deferUpdate();
      const config = await getCurrentTicketDashboardConfig(client, guildId);
      const prompt = buildTicketDashboardValuePrompt(interaction.guild, 'staff_role', config);
      await interaction.editReply(prompt || buildTicketDashboardPayload(interaction.guild, config));
    } catch (error) {
      logger.error('Ticket dashboard staff-role prompt failed', {
        guildId,
        error: error.message,
      });
      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = 'Could not open the staff-role setting. Please try again.';
      await interaction.editReply(payload).catch(() => {});
    }
  },
};

const repostHandler = {
  name: 'ticket_dashboard_repost',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    try {
      await interaction.deferUpdate();
      const { config } = await repostTicketPanel(client, interaction.guild);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = '✅ The ticket panel was reposted and the new message ID was saved.';
      await interaction.editReply(payload);
    } catch (error) {
      logger.error('Ticket dashboard repost failed', {
        guildId,
        error: error.message,
      });
      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not repost the ticket panel.';
      await interaction.editReply(payload).catch(() => {});
    }
  },
};

const deleteHandler = {
  name: 'ticket_dashboard_delete',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardInteraction(interaction, guildId))) return;

    try {
      await interaction.deferUpdate();
      await deleteTicketSystem(client, interaction.guild);
      await interaction.editReply({
        content: '✅ The ticket panel and saved ticket-system configuration have been removed. Run `/ticket setup` to create a new system.',
        embeds: [],
        components: [],
      });
    } catch (error) {
      logger.error('Ticket dashboard delete failed', {
        guildId,
        error: error.message,
      });
      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not delete the ticket system.';
      await interaction.editReply(payload).catch(() => {});
    }
  },
};

export default [backHandler, staffHandler, repostHandler, deleteHandler];
