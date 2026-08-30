import { EmbedBuilder } from 'discord.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { decorateEmbedWithSavedTemplate } from './embedTemplateService.js';
import { createStickyGuideManager } from './stickyGuideService.js';
import { findDedicatedChannelBySlug as findBySlug, rememberDedicatedCommandChannel } from './dedicatedChannelPolicy.js';

const CLOUDY_C_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

const CHANNEL_RULES = {
  shop: {
    slug: 'shop',
    guideTitle: 'Shop commands',
    guideDescription: 'All Cloudy shop and purchase commands must be used in this channel. Use `/shop` to browse and `/buy` to purchase items. These commands will not work in other channels.',
    wrongChannelMessage: 'Shop commands can only be used in the dedicated shop channel.',
  },
  gambling: {
    slug: 'gambling',
    guideTitle: 'Gambling & Games',
    guideDescription: 'All Cloudy gambling and game commands must be used in this channel. Use `/gamble`, `/fight`, `/flip`, or `/roll` here. These commands will not work in other channels.',
    wrongChannelMessage: 'Gambling and game commands can only be used in the dedicated gambling channel.',
  },
};

export async function resolveDedicatedChannel(guild, key) {
  const rule = CHANNEL_RULES[key];
  if (!guild || !rule) return null;

  let channel = findBySlug(guild, rule.slug);
  if (channel) return channel;

  await guild.channels.fetch().catch(() => null);
  channel = findBySlug(guild, rule.slug);
  return channel;
}

export async function enforceDedicatedCommandChannel(interaction, key) {
  const rule = CHANNEL_RULES[key];
  if (!rule || !interaction?.guild) return true;

  const targetChannel = await resolveDedicatedChannel(interaction.guild, key);
  rememberDedicatedCommandChannel(interaction, key, targetChannel?.id || null);
  if (!targetChannel) {
    return true;
  }

  const currentChannelId = interaction.channelId || interaction.channel?.id;
  if (currentChannelId === targetChannel.id) return true;

  throw createError(
    `Command used outside dedicated ${key} channel`,
    ErrorTypes.VALIDATION,
    key === 'gambling'
      ? 'Please use #gambling to play.'
      : `${rule.wrongChannelMessage} Use <#${targetChannel.id}>.`,
    {
      expectedChannelId: targetChannel.id,
      currentChannelId,
      dedicatedChannel: key,
      ...(key === 'gambling' ? { titleOverride: 'Wrong channel', showCloseButton: false } : {}),
    },
  );
}

function buildGuideEmbed(rule) {
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle(rule.guideTitle)
    .setDescription(rule.guideDescription)
    .setThumbnail(CLOUDY_C_LOGO_URL)
    .setFooter({ text: FOOTER });
}

function isGamblingGuide(message) {
  return message.embeds?.some(embed =>
    String(embed.title || '').toLowerCase() === 'gambling & games'
    || embed.description === CHANNEL_RULES.gambling.guideDescription
  ) || false;
}

function gamblingGuideStorageKey(channel) {
  return `cloudy:dedicated-guide:${channel.guild.id}:${channel.id}`;
}

const gamblingGuideManager = createStickyGuideManager({
  loadState: channel => getFromDb(gamblingGuideStorageKey(channel), null),
  saveState: (channel, state) => setInDb(gamblingGuideStorageKey(channel), state),
  isGuide: isGamblingGuide,
  onError: error => logger.warn(`Gambling guide refresh failed: ${error.message}`),
  async buildPayload(channel, existing) {
    if (existing?.embeds?.length) {
      // Keep changes made in the embed builder when moving the guide.
      return {
        content: existing.content || undefined,
        embeds: existing.embeds.map(embed => embed.toJSON()),
        files: [...(existing.attachments?.values() || [])].map(attachment => ({
          attachment: attachment.url,
          name: attachment.name,
        })),
        allowedMentions: { parse: [] },
      };
    }
    const { embed } = await decorateEmbedWithSavedTemplate(
      channel.guild.id,
      channel.id,
      buildGuideEmbed(CHANNEL_RULES.gambling),
    );
    return { embeds: [embed], allowedMentions: { parse: [] } };
  },
});

export function scheduleDedicatedChannelGuide(message) {
  if (!message?.guild || !message.channel) return false;
  const channel = findBySlug(message.guild, CHANNEL_RULES.gambling.slug);
  if (!channel || message.channel.id !== channel.id) return false;
  return gamblingGuideManager.schedule(message);
}

async function ensureGuideMessage(guild, key) {
  const rule = CHANNEL_RULES[key];
  const channel = await resolveDedicatedChannel(guild, key);
  if (!rule || !channel?.messages?.fetch) return false;

  if (key === 'gambling') {
    return gamblingGuideManager.refresh(channel).catch(error => {
      logger.warn(`Gambling guide setup failed: ${error.message}`);
      return false;
    });
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = recent?.find(message =>
    message.author?.id === guild.client.user?.id
    && message.embeds?.some(embed =>
      embed.title === rule.guideTitle
      || (key === 'gambling' && embed.title === 'Gambling & games')
    )
  ) || null;

  const payload = { embeds: [buildGuideEmbed(rule)] };
  if (existing) {
    await existing.edit(payload).catch(() => {});
    return true;
  }

  const sent = await channel.send(payload).catch(() => null);
  return Boolean(sent);
}

export async function ensureDedicatedChannelGuides(client) {
  const results = [];

  for (const guild of client.guilds.cache.values()) {
    for (const key of ['shop', 'gambling']) {
      const ok = await ensureGuideMessage(guild, key);
      results.push({ guildId: guild.id, key, ok });
    }
  }

  return results;
}
