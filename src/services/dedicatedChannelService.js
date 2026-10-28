import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { fetchGuildChannels } from '../utils/guildChannelFetch.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger, startupLog } from '../utils/logger.js';
import { ECONOMY_COMMAND_NAMES, EARN_MONEY_COMMAND_NAMES } from '../config/gamblingCommands.js';
import { createStickyGuideManager } from './stickyGuideService.js';
import { findDedicatedChannelBySlug as findBySlug, rememberDedicatedCommandChannel } from './dedicatedChannelPolicy.js';

const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const LEGACY_GAMBLING_GUIDE_DESCRIPTION = 'All Cloudy gambling and game commands must be used in this channel. Use `/gamble`, `/fight`, `/flip`, or `/roll` here. These commands will not work in other channels.';
const GAMBLING_GUIDE_DESCRIPTION = 'All Cloudy gaming and economy commands must be used in this channel. Click the button below to view all available commands.';

const CHANNEL_RULES = {
  shop: {
    slug: 'shop',
    guideTitle: 'Shop & Economy',
    guideDescription: 'All Cloudy shop & economy commands must be used in this channel. Click the button below to view all available commands.',
    wrongChannelMessage: 'Shop commands can only be used in the dedicated shop channel.',
  },
  gambling: {
    slug: 'gambling',
    guideTitle: 'Games & Economy',
    guideDescription: GAMBLING_GUIDE_DESCRIPTION,
    wrongChannelMessage: 'Gambling and game commands can only be used in the dedicated gambling channel.',
  },
};

// Use one title for the Gambling guide before any send or Reappear move.
// Only this exact guide title is normalized; custom titles are preserved.
export function canonicalGamblingGuideEmbedData(data) {
  if (!data || typeof data !== 'object'
    || !/^games\s*&\s*economy$/i.test(String(data.title || '').trim())
    || data.title === CHANNEL_RULES.gambling.guideTitle) return data;
  return { ...data, title: CHANNEL_RULES.gambling.guideTitle };
}

export async function resolveDedicatedChannel(guild, key) {
  const rule = CHANNEL_RULES[key];
  if (!guild || !rule) return null;

  let channel = findBySlug(guild, rule.slug);
  if (channel) return channel;

  await fetchGuildChannels(guild).catch(() => null);
  channel = findBySlug(guild, rule.slug);
  return channel;
}

export async function enforceDedicatedCommandChannel(interaction, key) {
  const rule = CHANNEL_RULES[key];
  if (!rule || !interaction?.guild) return true;

  const commandName = String(interaction.commandName || '').toLowerCase();
  const economy = ECONOMY_COMMAND_NAMES.has(commandName);
  const keys = economy ? ['gambling', 'shop'] : [key];
  const channels = (await Promise.all(keys.map(slug => resolveDedicatedChannel(interaction.guild, slug)))).filter(Boolean);
  rememberDedicatedCommandChannel(interaction, economy ? 'economy' : key, channels[0]?.id || null);
  if (!channels.length) return true;

  const currentChannelId = interaction.channelId || interaction.channel?.id;
  if (channels.some(channel => currentChannelId === channel.id)) return true;
  const mentions = channels.map(channel => `<#${channel.id}>`).join(' or ');
  const purpose = economy ? 'to use economy commands'
    : key === 'shop' ? 'for your purchases'
      : EARN_MONEY_COMMAND_NAMES.has(commandName) ? 'to earn money' : 'to play';
  throw createError(
    `Command used outside dedicated ${key} channel`,
    ErrorTypes.VALIDATION,
    `This command can only be used in the dedicated channel. Please use ${mentions} ${purpose}.`,
    {
      expectedChannelId: channels[0].id,
      currentChannelId,
      dedicatedChannel: economy ? 'economy' : key,
      titleOverride: 'Wrong channel', showCloseButton: false,
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

function isShopGuide(message) {
  return message.embeds?.some(embed =>
    ['shop commands', 'shop & economy'].includes(String(embed.title || '').toLowerCase())
    || embed.description === CHANNEL_RULES.shop.guideDescription
  ) || false;
}

function isGamblingGuide(message) {
  return message.embeds?.some(embed =>
    ['gambling & games', 'games & economy'].includes(String(embed.title || '').toLowerCase())
    || embed.description === CHANNEL_RULES.gambling.guideDescription
    || embed.description === LEGACY_GAMBLING_GUIDE_DESCRIPTION
  ) || false;
}

function guideStorageKey(channel) {
  return `cloudy:dedicated-guide:${channel.guild.id}:${channel.id}`;
}

export function buildDedicatedGuidePayload(key, existing = null) {
  const rule = CHANNEL_RULES[key];
  const embeds = existing?.embeds?.length
    ? existing.embeds.map(embed => embed.toJSON()) : [buildGuideEmbed(rule).toJSON()];
  // Normalize outgoing copies only. Never edit the visible message afterward.
  if (key === 'gambling') {
    for (let i = 0; i < embeds.length; i++) {
      embeds[i] = canonicalGamblingGuideEmbedData(embeds[i]);
    }
  }
  const components = existing ? existing.components || [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dedicated_commands:${key}`).setLabel('Commands').setStyle(ButtonStyle.Secondary),
  )];
  return {
    content: existing?.content || undefined,
    embeds, components,
    files: [...(existing?.attachments?.values() || [])].map(attachment => ({ attachment: attachment.url, name: attachment.name })),
    allowedMentions: { parse: [] },
  };
}

function guideManager(key, isGuide) {
  return createStickyGuideManager({
    loadState: channel => getFromDb(guideStorageKey(channel), null),
    saveState: (channel, state) => setInDb(guideStorageKey(channel), state),
    isGuide,
    onError: error => logger.warn(`${key} guide refresh failed: ${error.message}`),
    everyNMessages: 5,
    buildPayload: (_channel, existing) => buildDedicatedGuidePayload(key, existing),
  });
}
const shopGuideManager = guideManager('shop', isShopGuide);
const gamblingGuideManager = guideManager('gambling', isGamblingGuide);

export function scheduleDedicatedChannelGuide(message) {
  if (!message?.guild || !message.channel) return false;

  const shopChannel = findBySlug(message.guild, CHANNEL_RULES.shop.slug);
  if (shopChannel && message.channel.id === shopChannel.id) {
    return shopGuideManager.schedule(message);
  }

  const gamblingChannel = findBySlug(message.guild, CHANNEL_RULES.gambling.slug);
  if (gamblingChannel && message.channel.id === gamblingChannel.id) {
    return gamblingGuideManager.schedule(message);
  }

  return false;
}

async function ensureGuideMessage(guild, key) {
  const rule = CHANNEL_RULES[key];
  const channel = await resolveDedicatedChannel(guild, key);
  if (!rule || !channel?.messages?.fetch) return false;

  if (['shop', 'gambling'].includes(key)) {
    const manager = key === 'shop' ? shopGuideManager : gamblingGuideManager;
    try {
      const refreshed = await manager.refresh(channel);
      if (!refreshed) return false;
      const state = await getFromDb(guideStorageKey(channel), null);
      const message = state?.messageId ? await channel.messages.fetch({ message: state.messageId, force: true }) : null;
      const ready = Boolean(message?.components?.some(row => row.components?.some(button => button.customId === `dedicated_commands:${key}`)));
      if (ready) startupLog(`${key} Commands panel verified: ${message.id}`);
      else logger.warn(`${key} Commands panel is missing its Commands button`);
      return ready;
    } catch (error) {
      logger.warn(`${key} guide setup failed: ${error.message}`);
      return false;
    }
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const existing = recent?.find(message =>
    message.author?.id === guild.client.user?.id
    && message.embeds?.some(embed => embed.title === rule.guideTitle)
  ) || null;

  const payload = { embeds: [buildGuideEmbed(rule)] };
  if (existing) {
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
