import { Events } from 'discord.js';
import { normalizeCloudyChannelName } from '../services/cloudyChannelResolver.js';
import { aiErrorMessage } from '../services/aiSafety.js';
import {
  FAQ_AI_CHANNEL_ID,
  answerFaqQuestion,
  getFaqQuestionCooldown,
} from '../services/faqAiService.js';
import { logger } from '../utils/logger.js';

export function isFaqChatMessage(message) {
  if (!message?.guild || !message.client?.user?.id || message.author?.bot || message.webhookId) return false;
  const channelId = String(message.channelId || message.channel?.id || '');
  if (channelId !== FAQ_AI_CHANNEL_ID && normalizeCloudyChannelName(message.channel?.name) !== 'faq') return false;
  const content = String(message.content || '').trim();
  // Never intercept commands, embed actions, other channels or media uploads.
  return content.length >= 2 && content.length <= 1000
    && !/^[!/$]/.test(content)
    && !message.attachments?.size;
}

export default {
  name: Events.MessageCreate,
  async execute(message) {
    if (!isFaqChatMessage(message)) return;

    const botId = message.client.user.id;
    const question = String(message.content || '')
      .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
      .trim();
    if (question.length < 2) return;

    const cooldown = getFaqQuestionCooldown(message.author.id);
    if (cooldown > 0) {
      // Avoid flooding the public FAQ channel with rate-limit notices.
      return;
    }

    await message.channel?.sendTyping?.().catch(() => {});

    try {
      const answer = await answerFaqQuestion(message.client, question, message);
      await message.reply({
        content: `**Cloudy Assistant**\n${answer}`.slice(0, 1950),
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      logger.warn('[FAQ_CHAT] Could not answer:', error?.code || 'unavailable');
      await message.reply({
        content: `**Cloudy Assistant**\n${aiErrorMessage(error)}`,
        allowedMentions: { parse: [], repliedUser: false },
      }).catch(() => {});
    }
  },
};
