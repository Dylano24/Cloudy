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

const QUESTION_LABELS = {
  en: 'Your question',
  fr: 'Votre question',
  nl: 'Jouw vraag',
  de: 'Ihre Frage',
  es: 'Tu pregunta',
  it: 'La tua domanda',
  pt: 'Sua pergunta',
  tr: 'Sorunuz',
  pl: 'Twoje pytanie',
  ro: 'Întrebarea ta',
};

const LATIN_LANGUAGE_HINTS = {
  fr: ['bonjour', 'salut', 'pourquoi', 'comment', 'quel', 'quelle', 'quels', 'quelles', 'quoi', 'avec', 'dans', 'pour', 'est', 'sont', 'une', 'des', 'mon', 'ma', 'mes', 'je', 'vous', 'pas', 'merci'],
  nl: ['hallo', 'waarom', 'hoe', 'wat', 'welke', 'waar', 'mijn', 'jouw', 'voor', 'met', 'niet', 'dit', 'dat', 'kan', 'kun', 'heb', 'heeft', 'vraag'],
  de: ['hallo', 'warum', 'wie', 'was', 'welche', 'welcher', 'wo', 'mein', 'meine', 'mit', 'für', 'nicht', 'ist', 'sind', 'kann', 'frage'],
  es: ['hola', 'porqué', 'porque', 'cómo', 'como', 'qué', 'que', 'cuál', 'cual', 'dónde', 'donde', 'para', 'con', 'mi', 'una', 'está', 'esta', 'pregunta', 'gracias'],
  it: ['ciao', 'perché', 'perche', 'come', 'cosa', 'quale', 'dove', 'mio', 'mia', 'con', 'per', 'non', 'sono', 'domanda', 'grazie'],
  pt: ['olá', 'ola', 'porquê', 'porque', 'como', 'qual', 'onde', 'meu', 'minha', 'com', 'para', 'não', 'nao', 'uma', 'pergunta', 'obrigado'],
  tr: ['merhaba', 'neden', 'nasıl', 'nasil', 'ne', 'hangi', 'nerede', 'benim', 'ile', 'için', 'icin', 'değil', 'degil', 'soru', 'teşekkür'],
  pl: ['cześć', 'czesc', 'dlaczego', 'jak', 'co', 'który', 'ktory', 'gdzie', 'mój', 'moj', 'moja', 'dla', 'nie', 'jest', 'pytanie', 'dziękuję'],
  ro: ['salut', 'bună', 'buna', 'de ce', 'cum', 'ce', 'care', 'unde', 'meu', 'mea', 'pentru', 'cu', 'nu', 'este', 'întrebare', 'intrebare', 'mulțumesc'],
  en: ['hello', 'why', 'how', 'what', 'which', 'where', 'my', 'your', 'with', 'for', 'not', 'this', 'that', 'can', 'does', 'question', 'thanks'],
};

function detectLatinLanguage(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const scores = {};

  for (const [language, hints] of Object.entries(LATIN_LANGUAGE_HINTS)) {
    scores[language] = hints.reduce((score, hint) => {
      if (hint.includes(' ')) return score + (normalized.includes(hint) ? 1 : 0);
      return score + (tokens.has(hint) ? 1 : 0);
    }, 0);
  }

  if (/[éèêëàâçùûüîïôœ]/i.test(text)) scores.fr += 2;
  if (/[äöüß]/i.test(text)) scores.de += 2;
  if (/[¿¡ñ]/i.test(text)) scores.es += 2;
  if (/[ãõ]/i.test(text)) scores.pt += 2;
  if (/[ğışçöü]/i.test(text)) scores.tr += 2;
  if (/[ąćęłńóśźż]/i.test(text)) scores.pl += 2;
  if (/[ăâîșț]/i.test(text)) scores.ro += 2;

  const [language, score] = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])[0] || ['en', 0];

  return score > 0 ? language : null;
}

function getLocalizedQuestionLabel(question, answer) {
  const text = String(question || '');

  if (/\p{Script=Arabic}/u.test(text)) return 'سؤالك';
  if (/\p{Script=Hebrew}/u.test(text)) return 'השאלה שלך';
  if (/\p{Script=Greek}/u.test(text)) return 'Η ερώτησή σας';
  if (/\p{Script=Hangul}/u.test(text)) return '질문';
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'あなたの質問';
  if (/\p{Script=Han}/u.test(text)) return '你的问题';
  if (/\p{Script=Thai}/u.test(text)) return 'คำถามของคุณ';
  if (/\p{Script=Devanagari}/u.test(text)) return 'आपका प्रश्न';
  if (/[іїєґ]/iu.test(text)) return 'Ваше запитання';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'Ваш вопрос';

  const questionLanguage = detectLatinLanguage(text);
  if (questionLanguage) return QUESTION_LABELS[questionLanguage] || QUESTION_LABELS.en;

  const answerLanguage = detectLatinLanguage(answer);
  return QUESTION_LABELS[answerLanguage] || QUESTION_LABELS.en;
}

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
      const questionLabel = getLocalizedQuestionLabel(question, answer);
      const embed = new EmbedBuilder()
        .setColor('#000000')
        .setTitle('Cloudy Support Assistant')
        .setDescription(answer)
        .addFields({
          name: questionLabel,
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
