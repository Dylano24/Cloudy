import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import {
  FAQ_AI_BUTTON_ID,
  FAQ_AI_CHANNEL_ID,
  buildFaqQuestionModal,
} from '../../../services/faqAiService.js';

export default {
  name: FAQ_AI_BUTTON_ID,

  async execute(interaction) {
    if (interaction.channelId !== FAQ_AI_CHANNEL_ID) {
      await InteractionHelper.safeReply(interaction, {
        content: 'This FAQ assistant can only be used in the FAQ channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // The FAQ assistant now uses Groq. Do not block the button by checking
    // the old OPENAI_API_KEY variable.
    if (!process.env.GROQ_API_KEY?.trim()) {
      await InteractionHelper.safeReply(interaction, {
        content: 'The private FAQ assistant is temporarily unavailable. Please open a support ticket.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Showing the modal is the interaction acknowledgement, so do it
    // immediately and through the safe helper to avoid Discord's 3s timeout.
    const shown = await InteractionHelper.safeShowModal(
      interaction,
      buildFaqQuestionModal()
    );

    if (!shown && !interaction.replied && !interaction.deferred) {
      await InteractionHelper.safeReply(interaction, {
        content: 'I could not open the question form. Please click **Ask a question** again.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
