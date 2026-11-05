// Vote pictures (owner's choice): every option with a picture becomes a blue
// link to that picture on Discord's own picture server (cdn.discordapp.com),
// so it opens straight away: no website warning and no Cloudy address. The
// pictures are uploaded once to a private "vote-media" thread (in #botlog,
// only Cloudy and staff see it). Discord's picture links expire after about a
// day, so Cloudy renews the links of recent votes every 12 hours.
import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js';
import { getCloudyChannelDefinition, normalizeCloudyChannelName } from './cloudyChannelResolver.js';
import { logger } from '../utils/logger.js';

const THREAD_KEY = guildId => `guild:${guildId}:vote-media-thread`;
const THREAD_NAME = 'vote-media';

async function storageThread(client, guild, fallbackChannel) {
  const savedId = await client.db.get(THREAD_KEY(guild.id), null);
  if (savedId) {
    const existing = await client.channels.fetch(savedId).catch(() => null);
    // An archived thread opens again when Cloudy posts in it.
    if (existing?.send && !existing.locked) return existing;
  }
  // Private threads only exist in normal text channels: #botlog first, else
  // the vote's own channel (members never see a private thread).
  const botlog = botlogChannel(guild);
  const parents = [...new Set([botlog, fallbackChannel])]
    .filter(channel => channel?.type === ChannelType.GuildText && channel.threads?.create);
  let failure = null;
  for (const parent of parents) {
    try {
      const thread = await parent.threads.create({
        name: THREAD_NAME, type: ChannelType.PrivateThread, invitable: false,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: 'Cloudy vote pictures',
      });
      await client.db.set(THREAD_KEY(guild.id), thread.id);
      return thread;
    } catch (error) {
      failure = error;
    }
  }
  logger.warn(`[VOTE_MEDIA] No private thread for vote pictures: ${failure?.message || 'no text channel found'}`);
  // Last resort: #botlog itself (staff only).
  return botlog?.type === ChannelType.GuildText && botlog.send ? botlog : null;
}

function botlogChannel(guild) {
  const definition = getCloudyChannelDefinition('botlog');
  const names = new Set((definition?.aliases || []).map(normalizeCloudyChannelName));
  const channels = [...(guild.channels?.cache?.values?.() || [])].filter(channel => channel.type === ChannelType.GuildText);
  return channels.find(channel => channel.id === definition?.legacyId)
    || channels.find(channel => names.has(normalizeCloudyChannelName(channel.name))) || null;
}

const linksFrom = (message, names) => {
  const byName = new Map([...(message.attachments?.values?.() || [])].map(item => [item.name, item.url]));
  return names.map(name => (name ? byName.get(name) || null : null));
};

/**
 * Uploads the pictures (one entry per option, null without a picture) and
 * returns the picture link per option plus where they are stored.
 */
export async function uploadVotePictures(client, guild, fallbackChannel, files) {
  const thread = await storageThread(client, guild, fallbackChannel);
  if (!thread) throw new Error('Cloudy cannot store the pictures right now.');
  const message = await thread.send({ files: files.filter(Boolean), allowedMentions: { parse: [] } });
  const names = files.map(file => file?.name || null);
  return { links: linksFrom(message, names), media: { channelId: thread.id, messageId: message.id, names } };
}

/** Fresh picture links for a vote, or null when the stored pictures are gone. */
export async function freshVotePictureLinks(client, media) {
  const thread = await client.channels.fetch(media.channelId).catch(() => null);
  const message = await thread?.messages?.fetch?.(media.messageId).catch(() => null);
  return message ? linksFrom(message, media.names) : null;
}
