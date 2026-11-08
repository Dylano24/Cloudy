import { Events } from 'discord.js';
import { handleAutomationBuilderInteraction } from '../services/automationBuilderService.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction.customId?.startsWith('auto_builder:')) {
      await handleAutomationBuilderInteraction(interaction);
    }
  },
};
