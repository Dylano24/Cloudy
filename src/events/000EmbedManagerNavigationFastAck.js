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

    // Acknowledge the component immediately, before registry/database work starts.
    const originalUpdate = interaction.update.bind(interaction);
    const acknowledgement = interaction.deferUpdate().catch((error) => {
      if (!interaction.deferred && !interaction.replied) {
        logger.error('Embed manager navigation acknowledgement failed:', error);
      }
      return null;
    });

    // The manager itself is an ephemeral follow-up message. After deferUpdate(),
    // editReply() can target the original interaction response instead of the
    // follow-up that owns this component. Always edit the exact component message.
    interaction.update = async (payload) => {
      await acknowledgement;

      if (interaction.deferred || interaction.replied) {
        const messageId = interaction.message?.id;
        if (!messageId) {
          throw new Error('Embed manager navigation is missing its component message id.');
        }

        return interaction.webhook.editMessage(messageId, payload);
      }

      return originalUpdate(payload);
    };
  },
};
