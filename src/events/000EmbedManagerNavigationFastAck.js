import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const NAVIGATION_PREFIXES = [
  'simple_embed_modify_channel:',
  'simple_embed_modify_channel_page:',
  'simple_embed_modify_embed_page:',
];

function isEmbedManagerNavigation(interaction) {
  if (!interaction?.customId) return false;
  if (!interaction.isButton?.() && !interaction.isStringSelectMenu?.()) return false;
  return NAVIGATION_PREFIXES.some((prefix) => interaction.customId.startsWith(prefix));
}

export default {
  name: Events.InteractionCreate,
  once: false,

  execute(interaction) {
    if (!isEmbedManagerNavigation(interaction)) return;

    // Start Discord's acknowledgement immediately, before any registry/database work.
    // The embed-manager collector may continue doing its normal async work afterwards.
    const originalUpdate = interaction.update.bind(interaction);
    const acknowledgement = interaction.deferUpdate().catch((error) => {
      if (!interaction.deferred && !interaction.replied) {
        logger.error('Embed manager navigation acknowledgement failed:', error);
      }
      return null;
    });

    // Existing collector branches call interaction.update(...) after loading their data.
    // Once we have deferred the component, update() is no longer valid; transparently
    // route that render to editReply() so every navigation click stays acknowledged.
    interaction.update = async (payload) => {
      await acknowledgement;

      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
      }

      return originalUpdate(payload);
    };
  },
};
