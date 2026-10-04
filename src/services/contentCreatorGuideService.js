import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { createStickyGuideManager } from './stickyGuideService.js';
import { resolveCloudyChannel, normalizeCloudyChannelName } from './cloudyChannelResolver.js';
import { logger, startupLog } from '../utils/logger.js';

const PLATFORMS = ['youtube', 'twitch', 'tiktok'];
export const CONTENT_CREATORS_TEXT = 'At Cloudy, we support and encourage content creators by giving you a place to share your content.\n\nWe would also love to have your support through a small €3/month contribution, which also helps us keep our Discord and game servers running and continue developing Cloudy.\n\nYour subscription gives you **unlimited access to all channels in this category**, as long as your subscription remains active.\n\nYou can subscribe on our website by clicking the button below.';

function isGuide(message) {
  return message.embeds?.some(embed => /content creators/i.test(embed.title || '')) || false;
}

export function buildContentCreatorPayload(existing) {
  if (existing?.embeds?.length) {
    return {
      content: existing.content || undefined,
      embeds: existing.embeds.map(embed => {
        const data = embed.toJSON ? embed.toJSON() : structuredClone(embed);
        if (/content creators/i.test(data.title || '')) data.title = '🎥 Content Creators';
        return data;
      }),
      components: (existing.components || []).map(row => row.toJSON ? row.toJSON() : row),
      files: [...(existing.attachments?.values() || [])].map(file => ({ attachment: file.url, name: file.name })),
      allowedMentions: { parse: [] },
    };
  }
  return {
    embeds: [new EmbedBuilder().setTitle('🎥 Content Creators').setDescription(CONTENT_CREATORS_TEXT).setColor(0xFFFFFF)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Subscribe').setStyle(ButtonStyle.Link).setURL('https://cloudy-store-vert.vercel.app/'))],
    allowedMentions: { parse: [] },
  };
}

export function createContentCreatorGuideManager() {
  const key = channel => `global:content-creators:guide:${channel.guild.id}:${channel.id}`;
  return createStickyGuideManager({
    loadState: channel => channel.client.db.get(key(channel)),
    saveState: (channel, state) => channel.client.db.set(key(channel), state),
    isGuide,
    async prepareExisting(message) {
      if (message.embeds.some(embed => /content creators/i.test(embed.title || '') && embed.title !== '🎥 Content Creators')) {
        return message.edit({ embeds: buildContentCreatorPayload(message).embeds });
      }
      return message;
    },
    buildPayload: (_channel, existing) => buildContentCreatorPayload(existing),
    everyNMessages: 1,
    onError: error => logger.warn(`Content Creators guide refresh failed: ${error.message}`),
  });
}

const manager = createContentCreatorGuideManager();
export function scheduleContentCreatorGuide(message) {
  if (!message?.guild || message.author?.bot || !PLATFORMS.includes(normalizeCloudyChannelName(message.channel?.name))) return false;
  return manager.schedule(message);
}

export async function ensureContentCreatorGuides(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const platform of PLATFORMS) {
      const channel = await resolveCloudyChannel(client, platform, { guild, textOnly: true });
      if (channel) {
        const ready = await manager.refresh(channel).catch(error => logger.warn(`Content Creators ${platform}: ${error.message}`));
        startupLog(`Content Creators ${platform}: ${ready ? 'ready' : 'unavailable'} in channel ${channel.id}`);
      }
    }
  }
}
