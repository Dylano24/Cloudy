import { EmbedBuilder, Events } from 'discord.js';
import {
  createOwnerAssistantHandoff,
  getOwnerAssistantCooldown,
  isCloudyOwner,
} from '../services/ownerAssistantService.js';
import { logger } from '../utils/logger.js';

const OWNER_ASSISTANT_CHANNEL_NAME = 'botlog-commands';
const MAX_QUESTION_LENGTH = 3000;
const EMBED_CHUNK_SIZE = 3900;

function isOwnerAssistantChannel(message) {
  return String(message.channel?.name || '').toLowerCase() === OWNER_ASSISTANT_CHANNEL_NAME;
}

function splitText(value, maxLength = EMBED_CHUNK_SIZE) {
  const text = String(value || '').trim();
  if (!text) return [];
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildPacketEmbeds(message, result) {
  const chunks = splitText(result.text);

  return chunks.slice(0, 3).map((chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setTitle(index === 0 ? 'Cloudy Assistant' : `Cloudy Assistant • ${index + 1}`)
      .setDescription(chunk);

    if (index === chunks.length - 1 || index === 2) {
      const diagnostics = result.diagnostics || {};
      const footerParts = [
        `Owner: ${message.author.username}`,
        `Channels: ${diagnostics.readableChannelsScanned || 0}`,
        `Evidence: ${diagnostics.evidenceItems || 0}`,
        `Code files: ${diagnostics.githubFilesRead || 0}`,
        `Logs: ${diagnostics.runtimeLogLines || 0}`,
      ];
      embed.setFooter({ text: footerParts.join(' • ').slice(0, 2048) });
    }
    return embed;
  });
}

export default {
  name: Events.MessageCreate,

  async execute(message) {
    if (!message.guild || message.author?.bot) return;
    if (!isOwnerAssistantChannel(message)) return;
    if (!isCloudyOwner(message)) return;

    const question = String(message.content || '').trim();
    if (question.length < 3) return;

    const cooldown = getOwnerAssistantCooldown(message.author.id);
    if (cooldown > 0) {
      const seconds = Math.max(1, Math.ceil(cooldown / 1000));
      const cooldownMessage = await message.reply({
        content: `Cloudy Assistant is still processing requests. Try again in ${seconds}s.`,
        allowedMentions: { repliedUser: false },
      }).catch(() => null);
      if (cooldownMessage) {
        const timer = setTimeout(() => cooldownMessage.delete().catch(() => {}), 10_000);
        timer.unref?.();
      }
      return;
    }

    const normalizedQuestion = question.slice(0, MAX_QUESTION_LENGTH);
    const status = await message.reply({
      content: 'Cloudy Assistant is checking live server data, code, logs and relevant sources…',
      allowedMentions: { repliedUser: false },
    }).catch(() => null);

    try {
      const result = await createOwnerAssistantHandoff(
        message.client,
        message.guild,
        normalizedQuestion,
      );

      const embeds = buildPacketEmbeds(message, result);
      if (!embeds.length) throw new Error('Owner Assistant generated an empty response.');

      if (status) {
        await status.edit({ content: null, embeds: [embeds[0]] });
        for (const embed of embeds.slice(1)) await message.channel.send({ embeds: [embed] });
      } else {
        for (const embed of embeds) await message.channel.send({ embeds: [embed] });
      }

      logger.info(
        `[OWNER_ASSISTANT] mode=owner-assistant owner=${message.author.id} guild=${message.guild.id} `
        + `channel=${message.channel.id} evidence=${result.diagnostics?.evidenceItems || 0} provider=${result.diagnostics?.provider || 'unknown'}`,
      );
    } catch (error) {
      logger.error('[OWNER_ASSISTANT] Failed to answer owner request:', error);
      const failure = {
        content: 'Cloudy Assistant could not complete this request. No bot settings, embeds, code or server data were changed.',
        embeds: [],
      };
      if (status) await status.edit(failure).catch(() => {});
      else await message.reply({ ...failure, allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  },
};
