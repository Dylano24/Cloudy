import { MessageFlags } from 'discord.js';
import {
  FAQ_AI_BUTTON_ID,
  FAQ_AI_CHANNEL_ID,
  buildFaqQuestionModal,
} from '../../../services/faqAiService.js';

export default {
  name: FAQ_AI_BUTTON_ID,

  async execute(interaction) {
    if (interaction.channelId !== FAQ_AI_CHANNEL_ID) {
      await interaction.reply({
        content: 'This FAQ assistant can only be used in the FAQ channel.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (!process.env.OPENAI_API_KEY?.trim()) {
      await interaction.reply({
        content: 'The private FAQ assistant is temporarily unavailable. Please open a support ticket.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await interaction.showModal(buildFaqQuestionModal());
  },
};
