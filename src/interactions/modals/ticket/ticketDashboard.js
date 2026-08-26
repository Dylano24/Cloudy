import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { updateGuildConfig } from '../../../services/config/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const ALLOWED_TEXT_FIELDS = new Set(['ticketPanelTitle', 'ticketPanelMessage', 'ticketButtonLabel']);

function buildInstantSourceUpdate(interaction, field, rawValue) {
  const embeds = interaction.message?.embeds?.map(embed => embed.toJSON()) || [];
  const components = interaction.message?.components?.map(row => row.toJSON()) || [];

  if ((field === 'ticketPanelTitle' || field === 'ticketButtonLabel') && embeds[0]?.fields) {
    const fieldName = field === 'ticketPanelTitle' ? 'Panel Title' : 'Button Label';
    embeds[0].fields = embeds[0].fields.map(item => (
      item.name === fieldName
        ? { ...item, value: `\`${rawValue.replace(/`/g, "'")}\`` }
        : item
    ));
  }

  return {
    content: interaction.message?.content || '',
    embeds,
    components,
  };
}

async function persistTextSetting(client, interaction, guildId, field, rawValue) {
  try {
    await updateGuildConfig(client, guildId, {
      [field]: rawValue,
      dmOnClose: false,
    });
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

    void persistTextSetting(client, interaction, guildId, field, rawValue);
  },
};
