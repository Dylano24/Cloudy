import { Events } from 'discord.js';
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

    // Acknowledge immediately before any registry/database work.
    await interaction.deferUpdate().catch(() => null);

    try {
      const records = await getEmbedRegistry(interaction.guild.id);
      const payload = buildChannelPayload(interaction.guild, records, 0);
      const messageId = interaction.message?.id;

      if (!messageId) {
        throw new Error('Embed manager back navigation is missing its component message id.');
      }

      // This button lives on an ephemeral follow-up, so edit that exact message.
      await interaction.webhook.editMessage(messageId, payload);
    } catch (error) {
      logger.error('Persistent embed manager back navigation failed:', error);
    }
  },
};
