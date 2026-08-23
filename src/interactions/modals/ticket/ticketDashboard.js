import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  repostTicketPanel,
  updateLiveTicketPanel,
} from '../../../services/ticketDashboardService.js';
import { updateGuildConfig } from '../../../services/config/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const ALLOWED_TEXT_FIELDS = new Set(['ticketPanelMessage', 'ticketButtonLabel']);

function buildInstantSourceUpdate(interaction, field, rawValue) {
  const embeds = interaction.message?.embeds?.map(embed => embed.toJSON()) || [];
  const components = interaction.message?.components?.map(row => row.toJSON()) || [];

  if (field === 'ticketButtonLabel' && embeds[0]?.fields) {
    embeds[0].fields = embeds[0].fields.map(item => (
      item.name === 'Button Label'
        ? { ...item, value: `\`${rawValue}\`` }
        : item
    ));
  }

  return {
    content: interaction.message?.content || '',
    embeds,
    components,
  };
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
      // Acknowledge the modal immediately using only data Discord already sent
      // with the interaction. No config/database read is allowed before this.
      if (interaction.isFromMessage?.()) {
        await interaction.update(buildInstantSourceUpdate(interaction, field, rawValue));
      } else {
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

    // PostgreSQL + live panel synchronization never block the UI.
    void persistTextSetting(client, interaction, guildId, field, rawValue);
  },
};
