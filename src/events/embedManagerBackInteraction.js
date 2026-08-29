import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { buildChannelPayload } from '../services/embedManagerService.js';

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    if (!interaction.isButton?.()) return;
    if (interaction.customId !== 'simple_embed_modify_back') return;
    if (!interaction.guild) return;

    // Acknowledge immediately so Discord never shows "didn't respond in time".
    await interaction.deferUpdate().catch(() => null);

    try {
      const records = await getEmbedRegistry(interaction.guild.id);
      const payload = buildChannelPayload(interaction.guild, records, 0);

      const edited = await interaction.editReply(payload).catch(() => null);
      if (edited) return;

      await interaction.followUp({
        ...payload,
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    } catch (error) {
      logger.error('Persistent embed manager back navigation failed:', error);
    }
  },
};
