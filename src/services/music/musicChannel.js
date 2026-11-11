// Where the music guide and the player panel go (owner's choice): the channel
// 1565888094828498974. When that id is a server instead, its #music channel is
// used; without either, the home server's #music channel as before.
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from '../cloudyChannelResolver.js';

export const MUSIC_CHANNEL_ID = '1565888094828498974';

const aliases = () => getCloudyChannelDefinition('music')?.aliases || [];
const asTextChannel = channel => (channel?.guild && channel.isTextBased?.() && !channel.isThread?.() ? channel : null);

/** The owner's channel (or the #music channel of the server with that id). */
export async function resolveOwnerMusicChannel(client) {
  const cached = client?.channels?.cache?.get?.(MUSIC_CHANNEL_ID);
  const channel = asTextChannel(cached || await client?.channels?.fetch?.(MUSIC_CHANNEL_ID)?.catch?.(() => null));
  if (channel) return { channel, via: 'channel' };
  const server = client?.guilds?.cache?.get?.(MUSIC_CHANNEL_ID);
  const fromServer = server && asTextChannel(findCloudyChannelByAlias(server, aliases(), { textOnly: true }));
  return fromServer ? { channel: fromServer, via: 'server' } : null;
}

/** The music channel of this server: the owner's channel when it is in it, else its #music channel. */
export function musicChannelFor(guild) {
  if (!guild) return null;
  const owned = asTextChannel(guild.channels?.cache?.get?.(MUSIC_CHANNEL_ID));
  return owned || findCloudyChannelByAlias(guild, aliases(), { textOnly: true });
}
