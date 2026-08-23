import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { buildTicketDashboardPayload } from '../services/ticketDashboardViewService.js';
import { logger } from '../utils/logger.js';

const DASHBOARD_CONFIG_TIMEOUT_MS = 5000;

/**
 * Bound a side-effect-free configuration read so the dashboard can fail visibly
 * instead of waiting forever. The underlying read may finish later, but it does
 * not mutate the Discord interaction.
 */
function withConfigReadTimeout(promise, timeoutMs = DASHBOARD_CONFIG_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Ticket dashboard configuration load timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export default {
  name: Events.InteractionCreate,
  once: false,

  /**
   * Acknowledge and render /ticket dashboard before the general command router
   * performs slower policy/configuration checks.
   */
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

    interaction.__ticketDashboardFastPathHandled = true;

    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'You need the `Manage Channels` permission to change ticket-system settings.',
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      // Reply immediately instead of deferring. Discord then removes its native
      // "Cloudy Manager is thinking..." state straight away while the saved
      // dashboard configuration is loaded in the background of this response.
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Loading ticket dashboard…',
          flags: MessageFlags.Ephemeral,
        });
      }

      const config = await withConfigReadTimeout(
        getGuildConfig(client, interaction.guildId),
      );

      await interaction.editReply(buildTicketDashboardPayload(interaction.guild, config || {}));

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
        content: 'The ticket dashboard could not load. Please try again. If it keeps failing, contact support.',
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
