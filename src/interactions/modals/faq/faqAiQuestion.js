import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import {
  FAQ_AI_CHANNEL_ID,
  FAQ_AI_MODAL_ID,
  answerFaqQuestion,
  getFaqQuestionCooldown,
} from '../../../services/faqAiService.js';

export default {
  name: FAQ_AI_MODAL_ID,

  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });
    if (!deferred) return;

    if (interaction.channelId !== FAQ_AI_CHANNEL_ID) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'This FAQ assistant can only be used in the FAQ channel.',
        embeds: [],
        components: [],
      });
      return;
    }

    const question = interaction.fields.getTextInputValue('question')?.trim();
    if (!question) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'Please enter a question.',
        embeds: [],
        components: [],
      });
      return;
    }

    const cooldownMs = getFaqQuestionCooldown(interaction.user.id);
    if (cooldownMs > 0) {
      await InteractionHelper.safeEditReply(interaction, {
        content: `Please wait **${Math.ceil(cooldownMs / 1000)} seconds** before asking another question.`,
        embeds: [],
        components: [],
      });
      return;
    }

    try {
      const answer = await answerFaqQuestion(client, question);

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Cloudy FAQ Assistant')
        .setDescription(answer)
        .addFields({
          name: 'Your question',
          value: question.length > 1000 ? `${question.slice(0, 997)}...` : question,
          inline: false,
        })
        .setFooter({ text: 'Private response • Only you can see this message' })
        .setTimestamp();

      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [embed],
        components: [],
      });
    } catch (error) {
      logger.error('FAQ AI answer failed', {
        error: error?.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
      });

      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      const technicalError = String(error?.message || 'Unknown API error').slice(0, 1200);

      await InteractionHelper.safeEditReply(interaction, {
        content: isAdmin
          ? `The FAQ AI request failed.\n\n**Admin diagnostic:** ${technicalError}\n\nIf this mentions quota, billing, or credits, add API billing/credits in the OpenAI Platform account linked to this API key.`
          : 'The private FAQ assistant could not answer right now. Please open a support ticket.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
