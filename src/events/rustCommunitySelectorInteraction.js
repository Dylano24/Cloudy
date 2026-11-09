import { Events } from 'discord.js';
import { handleRustSelectorButton } from '../services/rustCommunityExtrasService.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from '../services/gameFeedService.js';

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    if (!interaction.isButton?.() || !interaction.customId?.startsWith('rustcommunity:role:')) return;
    try {
      await handleRustSelectorButton(interaction);
    } catch (error) {
      logger.warn('[RUST_COMMUNITY] Role selection failed:', error);
      const response = { embeds: [{
        title: 'Something went wrong', description: 'Could not update your server role.',
        color: 0x7A1712, thumbnail: { url: CLOUDY_C_LOGO_URL }, footer: { text: CLOUDY_FOOTER },
      }], allowedMentions: { parse: [] } };
      if (interaction.deferred || interaction.replied) await interaction.editReply(response).catch(() => {});
      else await interaction.reply({ ...response, ephemeral: true }).catch(() => {});
    }
  },
};
