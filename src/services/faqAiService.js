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
import { supportBotEmoji, ensureSupportBotEmoji } from './supportBotEmojiService.js';
import { createExplicitAiService } from './explicitAiService.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { buildCloudyPublicKnowledgeEvidence } from './cloudyPublicKnowledgeService.js';
import { getEmbedRegistry, registerCloudyEmbedMessage } from './embedRegistryService.js';
import { sameTicketComponents } from '../utils/ticket/ticketComponentEquality.js';

export const FAQ_AI_CHANNEL_ID = '1534654577385672917';
export const FAQ_AI_BUTTON_ID = 'faq_ai_question';
export const FAQ_AI_MODAL_ID = 'faq_ai_question_modal';

const FAQ_PANEL_STATE_KEY = `global:faq-ai:panel:${FAQ_AI_CHANNEL_ID}`;
const QUESTION_COOLDOWN_MS = 20_000;
const KNOWLEDGE_CACHE_TTL_MS = 60_000;
const recentQuestions = new Map();
let lastQuestionSweepAt = 0;
const runFaqKnowledgeAi = createExplicitAiService({
  askEvidence: buildCloudyPublicKnowledgeEvidence,
});

function buildPanelPayload(client) {
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
      .setLabel('Cloudy assistant')
      .setEmoji(supportBotEmoji(client))
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embedPayload], components: [row] };
}

export function buildFaqQuestionModal() {
  const questionInput = new TextInputBuilder()
    .setCustomId('question')
    .setLabel('What would you like to know?')
    .setPlaceholder('Ask about Cloudy, purchases, rules, commands or server information.')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(FAQ_AI_MODAL_ID)
    .setTitle('Ask Cloudy')
    .addComponents(new ActionRowBuilder().addComponents(questionInput));
}

function faqPanelComponents(message) {
  return (message?.components || []).flatMap(row => row?.components || []);
}

function hasFaqQuestionAction(message) {
  return faqPanelComponents(message)
    .some(component => component?.customId === FAQ_AI_BUTTON_ID);
}

export function isFaqAiPanelMessage(message, clientUserId) {
  if (message?.author?.id !== clientUserId) return false;
  if (hasFaqQuestionAction(message)) return true;

  const title = String(message?.embeds?.[0]?.title || '').trim().toLowerCase();
  return title === 'cloudy support assistant';
}

export function isFaqPanelComponentContractSafe(message, clientUserId) {
  if (message?.author?.id !== clientUserId) return false;

  const components = faqPanelComponents(message);
  if (components.length !== 1) return false;

  const only = components[0];
  return only?.customId === FAQ_AI_BUTTON_ID;
}

async function repairFaqPanelComponents(message, payload, clientUserId) {
  if (!message) return message;
  if (isFaqPanelComponentContractSafe(message, clientUserId)) {
    const button = faqPanelComponents(message)[0];
    const data = button.toJSON?.() || button;
    // Keep a deliberately customized label/style; replace only its old leading
    // question mark and emoji. The action stays faq_ai_question.
    const previousLabel = String(button.label || data.label || 'Cloudy assistant')
      .replace(/^[❔❓?]\s*/, '');
    const updated = new ButtonBuilder({...data, custom_id: FAQ_AI_BUTTON_ID})
      .setLabel(previousLabel === 'Ask a question' ? 'Cloudy assistant' : previousLabel)
      .setEmoji(payload.components[0].components[0].data.emoji);
    payload = {components: [new ActionRowBuilder().addComponents(updated)]};
  }
  const current = (message.components || []).map(row => row.toJSON?.() || row);
  const desired = payload.components.map(row => row.toJSON?.() || row);
  if (sameTicketComponents(current, desired)) return message;

  try {
    const repaired = await message.edit({ components: payload.components });
    return repaired || message;
  } catch (error) {
    logger.error('Failed to repair FAQ panel components:', {
      error: error?.message || String(error),
      guildId: message?.guildId,
      channelId: message?.channelId,
      messageId: message?.id,
    });
    throw error;
  }
}

export async function reconcileFaqAiPanel(client) {
  try {
    const channel = await resolveCloudyChannel(client, 'supportAssistant', { textOnly: true });
    if (!channel?.isTextBased?.() || channel.isThread?.()) return null;

    if (client?.application?.emojis) await ensureSupportBotEmoji(client);
    const payload = buildPanelPayload(client);
    let panelMessage = null;
    const savedMessageId = client.db?.get
      ? await client.db.get(FAQ_PANEL_STATE_KEY).catch(() => null)
      : null;

    if (savedMessageId) {
      panelMessage = await channel.messages.fetch(savedMessageId).catch(() => null);
      if (panelMessage && !isFaqAiPanelMessage(panelMessage, client.user.id)) panelMessage = null;
    }

    if (!panelMessage) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      panelMessage = recent?.find(message => isFaqAiPanelMessage(message, client.user.id)) || null;
    }

    if (panelMessage) {
      panelMessage = await repairFaqPanelComponents(panelMessage, payload, client.user.id);
    }

    panelMessage = panelMessage || await channel.send(payload);

    // Reused panels do not emit MessageCreate after a restart. Explicitly
    // re-register the complete live panel so Search uses the same snapshot and
    // components as channel Modify.
    const records = await getEmbedRegistry(panelMessage.guildId);
    const prior = records.find(record => record.messageId === panelMessage.id && Number(record.embedIndex || 0) === 0);
    const componentsChanged = !prior || !sameTicketComponents(prior.components || [], panelMessage.components || []);
    const registered = await registerCloudyEmbedMessage(panelMessage, 'bot-history', {manualSave: componentsChanged});
    if (componentsChanged && !registered) throw new Error('Could not record the assistant controls for Embed Builder');

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
  const result = await runFaqKnowledgeAi(actor, question);
  return result.text.length > 1800 ? `${result.text.slice(0, 1797)}...` : result.text;
}
