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

const FAQ_RESPONSE_DELETE_DELAY_MS = 5 * 60 * 1000;
const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

function scheduleEphemeralDeletion(interaction) {
  const timer = setTimeout(() => {
    interaction.deleteReply().catch(error => {
      if (![10008, 10062].includes(error?.code)) {
        logger.debug('FAQ AI auto-delete could not remove reply:', error?.message || error);
      }
    });
  }, FAQ_RESPONSE_DELETE_DELAY_MS);

  timer.unref?.();
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [] });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    scheduleEphemeralDeletion(interaction);
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
          scheduleEphemeralDeletion(interaction);
          return;
        }

        if (!process.env.GROQ_API_KEY?.trim()) {
          await interaction.reply({
            content: 'The private FAQ assistant is temporarily unavailable. Please open a support ticket.',
            flags: MessageFlags.Ephemeral,
          });
          scheduleEphemeralDeletion(interaction);
          return;
        }

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
        .setColor('#000000')
        .setTitle('Cloudy FAQ Assistant')
        .setDescription(answer)
        .addFields({
          name: 'Your question',
          value: question.length > 1000 ? `${question.slice(0, 997)}...` : question,
          inline: false,
        })
        .setFooter({ text: CLOUDY_FOOTER });

      const embedPayload = embed.toJSON();
      embedPayload.footer = { text: CLOUDY_FOOTER };

      await interaction.editReply({
        content: '',
        embeds: [embedPayload],
        components: [],
      });
      scheduleEphemeralDeletion(interaction);
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
