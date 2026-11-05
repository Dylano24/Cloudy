// Vote pictures (owner's choice): every option with a picture becomes a blue
// link to that picture on Discord's own picture server (cdn.discordapp.com),
// so it opens straight away: no website warning and no Cloudy address. The
// pictures are uploaded once to a private "vote-media" thread (in #botlog,
// only Cloudy and staff see it). Discord's picture links expire after about a
// day, so Cloudy renews the links of recent votes every 12 hours.
import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from './cloudyChannelResolver.js';

const THREAD_KEY = guildId => `guild:${guildId}:vote-media-thread`;
const THREAD_NAME = 'vote-media';

async function storageThread(client, guild, fallbackChannel) {
  const savedId = await client.db.get(THREAD_KEY(guild.id), null);
  if (savedId) {
    const existing = await client.channels.fetch(savedId).catch(() => null);
    // An archived thread opens again when Cloudy posts in it.
    if (existing?.send && !existing.locked) return existing;
  }
  const definition = getCloudyChannelDefinition('botlog');
  const parent = findCloudyChannelByAlias(guild, definition?.aliases || [], { textOnly: true }) || fallbackChannel;
  if (!parent?.threads?.create) return null;
  const thread = await parent.threads.create({
    name: THREAD_NAME, type: ChannelType.PrivateThread, invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: 'Cloudy vote pictures',
  });
  await client.db.set(THREAD_KEY(guild.id), thread.id);
  return thread;
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
