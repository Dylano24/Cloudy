// The "Cloudy music" guide in #music reappears at the bottom after every message
// of a member (owner's choice, like the Content Creators guides). The guide keeps
// whatever the owner made of it: its text, buttons and pictures are copied.
import { createStickyGuideManager } from '../stickyGuideService.js';
import { MUSIC_CHANNEL_ID, musicChannelFor, resolveOwnerMusicChannel } from './musicChannel.js';
import { isBuilderUiMessage } from '../../utils/builderSessionCleanup.js';
import { logger, startupLog } from '../../utils/logger.js';
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

// The owner's music channel in whatever server it is in; otherwise only the
// home server's #music channel.
function guideChannelFor(guild, client) {
  if (!guild || (client || guild.client)?.config?.features?.music === false) return null;
  const channel = musicChannelFor(guild);
  const homeGuildId = String(process.env.GUILD_ID || '').trim();
  if (!channel) return null;
  return channel.id === MUSIC_CHANNEL_ID || (homeGuildId && String(guild.id) === homeGuildId) ? channel : null;
}

// Bots never move the guide, members do.
export function scheduleMusicGuide(message) {
  if (!message?.guild || !message.channel || message.author?.bot) return false;
  const channel = guideChannelFor(message.guild, message.client);
  if (!channel || channel.id !== message.channel.id) return false;
  return manager.schedule(message);
}

// At startup: make sure the guide is there (placed again when it is gone), and
// say in the log which channel was found.
export async function ensureMusicGuide(client) {
  const owner = await resolveOwnerMusicChannel(client);
  const home = client?.guilds?.cache?.get?.(String(process.env.GUILD_ID || '').trim());
  const channel = owner?.channel || guideChannelFor(home, client);
  if (!channel) {
    startupLog(`Music guide: no music channel found (${MUSIC_CHANNEL_ID} is not a channel or server Cloudy can see)`);
    return false;
  }
  startupLog(`Music guide: ${owner ? `owner's ${owner.via}` : 'home server'} #${channel.name} (${channel.id}) in ${channel.guild?.name} (${channel.guild?.id})`);
  return manager.refresh(channel);
}
