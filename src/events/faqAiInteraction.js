import {
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  FAQ_AI_BUTTON_ID,
  FAQ_AI_CHANNEL_ID,
  FAQ_AI_MODAL_ID,
  answerFaqQuestion,
  buildFaqQuestionModal,
  getFaqQuestionCooldown,
} from '../services/faqAiService.js';

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [] });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.warn('FAQ AI fallback response failed:', error?.message || error);
  }
}

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction, client) {
    if (interaction.isButton() && interaction.customId === FAQ_AI_BUTTON_ID) {
      try {
        if (interaction.channelId !== FAQ_AI_CHANNEL_ID) {
          await interaction.reply({
            content: 'This FAQ assistant can only be used in the FAQ channel.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!process.env.GROQ_API_KEY?.trim()) {
          await interaction.reply({
            content: 'The private FAQ assistant is temporarily unavailable. Please open a support ticket.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // showModal itself acknowledges the Discord button interaction.
        // Do this immediately so the button can never hit Discord's 3 second timeout.
        await interaction.showModal(buildFaqQuestionModal());
      } catch (error) {
        logger.error('FAQ AI button failed:', {
          error: error?.message,
          code: error?.code,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user?.id,
        });

        if (!interaction.replied && !interaction.deferred) {
          await replyEphemeral(
            interaction,
            'I could not open the question form. Please click **Ask a question** again.'
          );
        }
      }
      return;
    }

    if (!interaction.isModalSubmit() || interaction.customId !== FAQ_AI_MODAL_ID) {
      return;
    }

    // Acknowledge the submitted modal immediately. Groq can then take as long as
    // needed within Discord's deferred interaction window without timing out.
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      logger.error('FAQ AI modal defer failed:', {
        error: error?.message,
        code: error?.code,
        userId: interaction.user?.id,
      });
      return;
    }

    if (interaction.channelId !== FAQ_AI_CHANNEL_ID) {
      await replyEphemeral(interaction, 'This FAQ assistant can only be used in the FAQ channel.');
      return;
    }

    const question = interaction.fields.getTextInputValue('question')?.trim();
    if (!question) {
      await replyEphemeral(interaction, 'Please enter a question.');
      return;
    }

    const cooldownMs = getFaqQuestionCooldown(interaction.user.id);
    if (cooldownMs > 0) {
      await replyEphemeral(
        interaction,
        `Please wait **${Math.ceil(cooldownMs / 1000)} seconds** before asking another question.`
      );
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

      await interaction.editReply({
        content: '',
        embeds: [embed],
        components: [],
      });
    } catch (error) {
      logger.error('FAQ AI answer failed:', {
        error: error?.message,
        code: error?.code,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user?.id,
      });

      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      const technicalError = String(error?.message || 'Unknown Groq API error').slice(0, 1200);

      await replyEphemeral(
        interaction,
        isAdmin
          ? `The FAQ AI request failed.\n\n**Admin diagnostic:** ${technicalError}\n\nCheck that \`GROQ_API_KEY\` is set in Railway. If the error mentions rate limits, wait briefly and try again.`
          : 'The private FAQ assistant could not answer right now. Please open a support ticket.'
      );
    }
  },
};
