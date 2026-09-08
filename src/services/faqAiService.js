import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { runExplicitAi } from './explicitAiService.js';

export const FAQ_AI_CHANNEL_ID = '1534654577385672917';
export const FAQ_AI_BUTTON_ID = 'faq_ai_question';
export const FAQ_AI_MODAL_ID = 'faq_ai_question_modal';

const FAQ_PANEL_STATE_KEY = `global:faq-ai:panel:${FAQ_AI_CHANNEL_ID}`;
const QUESTION_COOLDOWN_MS = 20_000;
const KNOWLEDGE_CACHE_TTL_MS = 60_000;
const recentQuestions = new Map();
let lastQuestionSweepAt = 0;

function buildPanelPayload() {
  const footerText = '© Cloudy Inc. • Quality. Innovation. Performance.';
  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle('Cloudy Support Assistant')
    .setDescription(
      'Have a question or need help with something?\n\n' +
      'Our AI Assistant can help you find answers to common questions, server information, features, commands, and more.\n\n' +
      'You can ask your question in any language, and you’ll receive a response in the same language.\n\n' +
      'Click **Ask a question** below and let Cloudy Inc. assist you.'
    )
    .setFooter({ text: footerText });

  const embedPayload = embed.toJSON();
  embedPayload.footer = { text: footerText };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(FAQ_AI_BUTTON_ID)
      .setLabel('❔Ask a question')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embedPayload], components: [row] };
}

export function buildFaqQuestionModal() {
  const questionInput = new TextInputBuilder()
    .setCustomId('question')
    .setLabel('What would you like to know?')
    .setPlaceholder('Ask a question; no channels are read automatically. Type help for commands. Do not submit secrets.')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(FAQ_AI_MODAL_ID)
    .setTitle('Ask Cloudy')
    .addComponents(new ActionRowBuilder().addComponents(questionInput));
}

function isFaqPanelMessage(message, clientUserId) {
  return message.author?.id === clientUserId && message.components?.some(row =>
    row.components?.some(component => component.customId === FAQ_AI_BUTTON_ID)
  );
}

export async function reconcileFaqAiPanel(client) {
  try {
    const channel = await client.channels.fetch(FAQ_AI_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) return null;

    const payload = buildPanelPayload();
    let panelMessage = null;
    const savedMessageId = client.db?.get
      ? await client.db.get(FAQ_PANEL_STATE_KEY).catch(() => null)
      : null;

    if (savedMessageId) {
      panelMessage = await channel.messages.fetch(savedMessageId).catch(() => null);
      if (panelMessage && !isFaqPanelMessage(panelMessage, client.user.id)) panelMessage = null;
    }

    if (!panelMessage) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      panelMessage = recent?.find(message => isFaqPanelMessage(message, client.user.id)) || null;
    }

    panelMessage = panelMessage || await channel.send(payload);
    if (client.db?.set) await client.db.set(FAQ_PANEL_STATE_KEY, panelMessage.id).catch(() => {});
    return panelMessage;
  } catch (error) {
    logger.error('Failed to reconcile FAQ AI panel:', error);
    return null;
  }
}

export function getFaqQuestionCooldown(userId) {
  const now = Date.now();
  if (now - lastQuestionSweepAt >= KNOWLEDGE_CACHE_TTL_MS) {
    lastQuestionSweepAt = now;
    for (const [storedUserId, askedAt] of recentQuestions) {
      if (now - askedAt >= QUESTION_COOLDOWN_MS) {
        recentQuestions.delete(storedUserId);
      }
    }
  }

  const previous = recentQuestions.get(userId) || 0;
  const remaining = QUESTION_COOLDOWN_MS - (now - previous);

  if (remaining > 0) return remaining;

  recentQuestions.set(userId, now);
  return 0;
}

export async function answerFaqQuestion(client, question, actor) {
  if (!actor || actor.client !== client) throw new Error('forbidden');
  const result = await runExplicitAi(actor, question);
  return result.text.length > 1800 ? `${result.text.slice(0, 1797)}...` : result.text;
}
