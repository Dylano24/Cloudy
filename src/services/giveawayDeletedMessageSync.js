// Keep the giveaway database in sync when the original giveaway message or
// its channel is removed directly in Discord, outside /giveaway manage.
import { getGuildGiveaways, deleteGiveaway } from '../utils/giveaways.js';
import { Mutex } from '../utils/mutex.js';
import { logger } from '../utils/logger.js';

// entries: [{ messageId, channelId }]; deletedChannelId: the entire removed
// channel. Ignore winner announcements and unrelated bot/member messages.
export async function cleanupDeletedGiveaways(client, guildId, {
  entries = [], deletedChannelId = null,
} = {}) {
  if (!client?.db || !guildId || (!entries.length && !deletedChannelId)) return 0;
  const deleted = new Set(entries.filter(x => x?.messageId && x?.channelId)
    .map(x => String(x.channelId) + ':' + String(x.messageId)));
  const list = await getGuildGiveaways(client, guildId, { strict: true });
  let removed = 0;
  for (const candidate of list) {
    const channelId = String(candidate?.channelId || '');
    const messageId = String(candidate?.messageId || '');
    if (!channelId || !messageId) continue;
    if (channelId !== deletedChannelId && !deleted.has(channelId + ':' + messageId)) continue;
    // Share the same per-giveaway lock used by End, Reroll, Edit and Delete,
    // so an in-flight action cannot re-create a deleted record.
    await Mutex.runExclusive('giveaway:' + messageId, async () => {
      const fresh = (await getGuildGiveaways(client, guildId, { strict: true }))
        .find(item => String(item?.messageId) === messageId);
      if (!fresh || String(fresh.channelId) !== channelId) return;
      if (!await deleteGiveaway(client, guildId, messageId)) {
        throw new Error('Could not remove deleted giveaway ' + messageId + ' from database');
      }
      removed++;
    });
  }
  if (removed) logger.info('Removed ' + removed + ' deleted giveaway record(s) in guild ' + guildId);
  return removed;
}
