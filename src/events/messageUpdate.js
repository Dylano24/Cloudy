import { Events, SnowflakeUtil } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { captureMessageSnapshot, getMessageSnapshot } from '../services/messageSnapshotService.js';

const MAX_LOGGED_EDIT_CONTENT_LENGTH = 512;
// Without a cached or stored "before", only a message Discord itself marks
// as just edited is a real edit (link previews update without edited_at).
const UNCACHED_EDIT_WINDOW_MS = 60_000;

function truncate(value) {
  return value.length > MAX_LOGGED_EDIT_CONTENT_LENGTH
    ? `${value.substring(0, MAX_LOGGED_EDIT_CONTENT_LENGTH - 3)}...`
    : value;
}

function createdAt(message) {
  const known = Number(message.createdTimestamp);
  if (Number.isFinite(known) && known > 0) return known;
  try {
    return SnowflakeUtil.timestampFrom(String(message.id));
  } catch {
    return null;
  }
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    try {
      if (!newMessage.guild) return;
      // Read the stored copy before replacing it with the edited version.
      const oldUnknown = oldMessage?.partial || typeof oldMessage?.content !== 'string';
      const stored = oldUnknown ? await getMessageSnapshot(newMessage.guild.id, newMessage.id) : null;
      if (!newMessage.partial) void captureMessageSnapshot(newMessage);

      // Bot edits update their public messages, not durable Builder storage.
      // Explicit saves persist through the Builder and source catalog owners.
      if (newMessage.author?.id === newMessage.client.user?.id) return;
      if (newMessage.author?.bot) return;

      const before = oldUnknown ? (typeof stored?.content === 'string' ? stored.content : null) : oldMessage.content;
      if (before === null) {
        if (typeof newMessage.content !== 'string') return;
        const editedAt = Number(newMessage.editedTimestamp) || 0;
        if (!editedAt || Date.now() - editedAt > UNCACHED_EDIT_WINDOW_MS) return;
      } else if (before === newMessage.content) {
        return;
      }

      const created = createdAt(newMessage);
      const channelId = newMessage.channelId || newMessage.channel?.id;
      const metaLines = [
        formatLogLine('Channel', channelId ? `<#${channelId}>` : 'Unknown'),
        formatLogLine('Message ID', `\`${newMessage.id}\``),
        formatLogLine('Message author', newMessage.author ? `<@${newMessage.author.id}>` : 'Unknown'),
        formatLogLine('Message created', created ? `<t:${Math.floor(created / 1000)}:f>` : 'Unknown'),
      ];

      const oldContent = before === null
        ? '*(not cached before the edit)*'
        : before || '*(empty message)*';
      const newContent = newMessage.content || '*(empty message)*';

      await logEvent({
        client: newMessage.client,
        guildId: newMessage.guild.id,
        eventType: EVENT_TYPES.MESSAGE_EDIT,
        data: {
          title: 'Message edited',
          lines: metaLines,
          quoted: true,
          fields: [
            { name: 'Before', value: truncate(oldContent), inline: true },
            { name: 'After', value: truncate(newContent), inline: true },
          ],
          userId: newMessage.author?.id,
          channelId,
        }
      });

    } catch (error) {
      logger.error('Error in messageUpdate event:', error);
    }
  }
};
