// The "Cloudy music" guide in #music reappears at the bottom after every message
// of a member (owner's choice, like the Content Creators guides). The guide keeps
// whatever the owner made of it: its text, buttons and pictures are copied.
import { createStickyGuideManager } from '../stickyGuideService.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../cloudyChannelResolver.js';
import { isBuilderUiMessage } from '../../utils/builderSessionCleanup.js';
import { logger } from '../../utils/logger.js';
import { buildMusicGuideEmbed } from './musicEmbeds.js';
import { buildMusicGuideComponents } from './musicGuidePanel.js';

const GUIDE_TITLE = 'Cloudy music';

// The Builder's own preview of the guide carries the same embed: it is not the guide.
export function isMusicGuide(message) {
  return !isBuilderUiMessage(message) && Boolean(message?.embeds?.some(embed => embed.title === GUIDE_TITLE));
}

export function buildMusicGuideCopy(existing) {
  // The guide is always there (owner's choice): when it is gone, the standard
  // one is placed again. An existing guide is moved with everything the owner made of it.
  if (!existing?.embeds?.length) {
    return {
      embeds: [buildMusicGuideEmbed().toJSON()],
      components: buildMusicGuideComponents().map(row => row.toJSON()),
      allowedMentions: { parse: [] },
    };
  }
  return {
    content: existing.content || undefined,
    embeds: existing.embeds.map(embed => (embed.toJSON ? embed.toJSON() : structuredClone(embed))),
    components: (existing.components || []).map(row => (row.toJSON ? row.toJSON() : row)),
    files: [...(existing.attachments?.values() || [])].map(file => ({ attachment: file.url, name: file.name })),
    allowedMentions: { parse: [] },
  };
}

function stateKey(channel) {
  return `global:music:guide-sticky:${channel.guild.id}:${channel.id}`;
}

async function rememberPublishedGuide(message) {
  const client = message.client || message.guild?.client;
  // The guide's saved identity follows the new message (see reconcileMusicGuideMessage).
  await client?.db?.set?.(`cloudy:music:guide:${message.guildId}`, { channelId: message.channelId, messageId: message.id });
  try {
    const { registerCloudyEmbedMessage } = await import('../embedRegistryService.js');
    await registerCloudyEmbedMessage(message, 'music-guide');
  } catch (error) {
    logger.debug(`Music guide registry update skipped: ${error?.message || error}`);
  }
}

export function createMusicGuideManager() {
  return createStickyGuideManager({
    loadState: channel => channel.client.db.get(stateKey(channel)),
    saveState: (channel, state) => channel.client.db.set(stateKey(channel), state),
    isGuide: isMusicGuide,
    buildPayload: (_channel, existing) => buildMusicGuideCopy(existing),
    onPublished: rememberPublishedGuide,
    everyNMessages: 1,
    moveDelayMs: 2000,
    onError: error => logger.warn(`Music guide refresh failed: ${error?.message || error}`),
  });
}

const manager = createMusicGuideManager();

// Only the home server's music channel.
function homeMusicChannel(guild, client) {
  const homeGuildId = String(process.env.GUILD_ID || '').trim();
  if (!guild || !homeGuildId || String(guild.id) !== homeGuildId) return null;
  if ((client || guild.client)?.config?.features?.music === false) return null;
  return findCloudyChannelByAlias(guild, getCloudyChannelDefinition('music')?.aliases || [], { textOnly: true });
}

// Bots never move the guide, members do.
export function scheduleMusicGuide(message) {
  if (!message?.guild || !message.channel || message.author?.bot) return false;
  const channel = homeMusicChannel(message.guild, message.client);
  if (!channel || channel.id !== message.channel.id) return false;
  return manager.schedule(message);
}

// At startup: make sure the guide is there (placed again when it is gone).
export async function ensureMusicGuide(client) {
  const guild = client?.guilds?.cache?.get?.(String(process.env.GUILD_ID || '').trim());
  const channel = homeMusicChannel(guild, client);
  if (!channel) return false;
  return manager.refresh(channel);
}
