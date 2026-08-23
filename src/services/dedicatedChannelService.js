import { EmbedBuilder } from 'discord.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';

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

function isUsableTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && channel?.isSendable?.());
}

function findBySlug(guild, slug) {
  const normalizedSlug = String(slug).toLowerCase();
  return guild.channels.cache.find(channel =>
    isUsableTextChannel(channel)
    && String(channel.name || '').toLowerCase().includes(normalizedSlug)
  ) || null;
}

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
  if (!targetChannel) {
    return true;
  }

  const currentChannelId = interaction.channelId || interaction.channel?.id;
  if (currentChannelId === targetChannel.id) return true;

  throw createError(
    `Command used outside dedicated ${key} channel`,
    ErrorTypes.VALIDATION,
    `${rule.wrongChannelMessage} Use <#${targetChannel.id}>.`,
    {
      expectedChannelId: targetChannel.id,
      currentChannelId,
      dedicatedChannel: key,
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

async function ensureGuideMessage(guild, key) {
  const rule = CHANNEL_RULES[key];
  const channel = await resolveDedicatedChannel(guild, key);
  if (!rule || !channel?.messages?.fetch) return false;

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

async function removeInactiveShopMessages(guild) {
  const channel = await resolveDedicatedChannel(guild, 'shop');
  if (!channel?.messages?.fetch) return;

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;

  const removable = recent.filter(message =>
    message.author?.id === guild.client.user?.id
    && message.embeds?.some(embed => embed.title === 'Shop commands' || embed.title === 'Store')
  );

  for (const message of removable.values()) {
    await message.delete().catch(() => {});
  }
}

export async function ensureDedicatedChannelGuides(client) {
  const results = [];

  for (const guild of client.guilds.cache.values()) {
    await removeInactiveShopMessages(guild);

    const ok = await ensureGuideMessage(guild, 'gambling');
    results.push({ guildId: guild.id, key: 'gambling', ok });
  }

  return results;
}
