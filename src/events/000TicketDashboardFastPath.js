import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { buildTicketDashboardPayload } from '../services/ticketDashboardViewService.js';
import { logger } from '../utils/logger.js';

const DASHBOARD_TIMEOUT_MS = 5000;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    if (!interaction.isChatInputCommand?.()) return;
    if (interaction.commandName !== 'ticket') return;

    let subcommand;
    try {
      subcommand = interaction.options.getSubcommand(false);
    } catch {
      return;
    }

    if (subcommand !== 'dashboard') return;

    // The normal command router performs several async checks before the ticket
    // command itself gets a chance to acknowledge Discord. If any dependency is
    // slow, Discord leaves the admin staring at "Cloudy Manager is thinking".
    // Handle dashboard opening immediately and mark the interaction so the
    // regular ticket command does not render it a second time later.
    interaction.__ticketDashboardFastPathHandled = true;

    try {
      if (!interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'You need the `Manage Channels` permission to change ticket-system settings.',
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      const config = await withTimeout(
        getGuildConfig(client, interaction.guildId),
        DASHBOARD_TIMEOUT_MS,
        'Ticket dashboard configuration load',
      );

      await withTimeout(
        interaction.editReply(buildTicketDashboardPayload(interaction.guild, config || {})),
        DASHBOARD_TIMEOUT_MS,
        'Ticket dashboard Discord response',
      );

      logger.info('Ticket dashboard fast path rendered', {
        guildId: interaction.guildId,
        userId: interaction.user?.id,
      });
    } catch (error) {
      logger.error('Ticket dashboard fast path failed', {
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        error: error?.message || String(error),
        stack: error?.stack,
      });

      const payload = {
        content: `The ticket dashboard could not load: ${String(error?.message || error).slice(0, 500)}`,
        embeds: [],
        components: [],
      };

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(payload);
        } else {
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        logger.error('Ticket dashboard fast path fallback reply failed', {
          guildId: interaction.guildId,
          error: replyError?.message || String(replyError),
        });
      }
    }
  },
};
