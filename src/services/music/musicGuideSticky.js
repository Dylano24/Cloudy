// The "Cloudy music" guide in #music reappears at the bottom after every message
// of a member (owner's choice, like the Content Creators guides). The guide keeps
// whatever the owner made of it: its text, buttons and pictures are copied.
import { createStickyGuideManager } from '../stickyGuideService.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../cloudyChannelResolver.js';
import { isBuilderUiMessage } from '../../utils/builderSessionCleanup.js';
import { logger } from '../../utils/logger.js';

const GUIDE_TITLE = 'Cloudy music';
const NO_GUIDE = 'MUSIC_GUIDE_MISSING';

// The Builder's own preview of the guide carries the same embed: it is not the guide.
export function isMusicGuide(message) {
  return !isBuilderUiMessage(message) && Boolean(message?.embeds?.some(embed => embed.title === GUIDE_TITLE));
}

export function buildMusicGuideCopy(existing) {
  // Never bring back a guide the owner removed: only an existing one is moved.
  if (!existing?.embeds?.length) throw new Error(NO_GUIDE);
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
    onError: error => {
      if (error?.message !== NO_GUIDE) logger.warn(`Music guide refresh failed: ${error?.message || error}`);
    },
  });
}

const manager = createMusicGuideManager();

// Only in the home server's music channel; bots never move it, members do.
export function scheduleMusicGuide(message) {
  if (!message?.guild || !message.channel || message.author?.bot) return false;
  const homeGuildId = String(process.env.GUILD_ID || '').trim();
  if (!homeGuildId || String(message.guild.id) !== homeGuildId) return false;
  if (message.client?.config?.features?.music === false) return false;
  const channel = findCloudyChannelByAlias(message.guild, getCloudyChannelDefinition('music')?.aliases || [], { textOnly: true });
  if (!channel || channel.id !== message.channel.id) return false;
  return manager.schedule(message);
}
