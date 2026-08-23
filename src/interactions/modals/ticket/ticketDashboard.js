import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  repostTicketPanel,
  updateLiveTicketPanel,
} from '../../../services/ticketDashboardService.js';
import { getGuildConfig, updateGuildConfig } from '../../../services/config/guildConfig.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const ALLOWED_TEXT_FIELDS = new Set(['ticketPanelMessage', 'ticketButtonLabel']);
const FAST_CONFIG_TIMEOUT_MS = 350;

async function getConfigForInstantRender(client, guildId) {
  let timer;
  try {
    return await Promise.race([
      getGuildConfig(client, guildId),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), FAST_CONFIG_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

async function persistTextSetting(client, interaction, guildId, field, rawValue) {
  try {
    const savedConfig = await updateGuildConfig(client, guildId, {
      [field]: rawValue,
      dmOnClose: false,
    });

    await ensureLivePanel(client, interaction.guild, savedConfig);
  } catch (error) {
    logger.error('Background ticket dashboard text save failed', {
      guildId,
      field,
      userId: interaction.user?.id,
      error: error.message,
      stack: error.stack,
    });

    // The dashboard was optimistically updated so the UI never blocks. If the
    // persistent write fails, surface a separate error without replacing the
    // dashboard itself.
    await interaction.followUp({
      content: error?.userMessage || 'Could not save that ticket setting permanently. Please try again.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

export default {
  name: 'ticket_dashboard_modal',

  async execute(interaction, client, args = []) {
    const [guildId, field] = args;
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

    const rawValue = interaction.fields.getTextInputValue('value');
    if (rawValue === null || rawValue === undefined || rawValue.length === 0) {
      await InteractionHelper.safeReply(interaction, {
        content: 'Enter a value before saving.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      // This modal was opened from the ephemeral dashboard message. Discord
      // allows a modal submit from a message component to update that source
      // message directly. This is the only reliable way to refresh an ephemeral
      // dashboard; channel.messages.fetch() cannot retrieve ephemeral messages.
      const currentConfig = await getConfigForInstantRender(client, guildId);

      if (currentConfig && interaction.isFromMessage?.()) {
        const optimisticConfig = {
          ...currentConfig,
          [field]: rawValue,
          dmOnClose: false,
        };

        // Acknowledge + redraw in one callback. No "Saving ticket setting..."
        // message and no waiting for PostgreSQL or the public ticket panel.
        await interaction.update(
          buildTicketDashboardPayload(interaction.guild, optimisticConfig),
        );
      } else {
        // Rare fallback: acknowledge instantly without creating a second loading
        // message. The next dashboard open will read the persisted config.
        await interaction.deferUpdate();
      }
    } catch (error) {
      logger.error('Ticket dashboard instant modal update failed', {
        guildId,
        field,
        error: error.message,
      });

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
    }

    // Persistence and live panel synchronization happen after Discord has
    // already updated the administrator's dashboard.
    void persistTextSetting(client, interaction, guildId, field, rawValue);
  },
};
