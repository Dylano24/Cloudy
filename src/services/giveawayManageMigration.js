// ONE-TIME migration for giveaway posts created before /giveaway manage.
// Remove only the public Manage component; never edit embed content, mentions,
// existing Enter/Leave buttons or any third-party messages.
import { getGuildGiveaways } from '../utils/giveaways.js';
import { logger } from '../utils/logger.js';

export async function removeLegacyGiveawayManageButtons(client) {
  const totals = { scanned: 0, changed: 0, failed: 0 };
  for (const guild of client.guilds?.cache?.values?.() || []) {
    let giveaways;
    try {
      giveaways = await getGuildGiveaways(client, guild.id, { strict: true });
    } catch (error) {
      totals.failed++;
      logger.warn('Could not load giveaways for one-time Manage button removal in ' + guild.id, error);
      continue;
    }
    for (const giveaway of giveaways) {
      if (!giveaway?.messageId || !giveaway?.channelId) continue;
      totals.scanned++;
      try {
        const channel = guild.channels.cache?.get(giveaway.channelId)
          || await guild.channels.fetch(giveaway.channelId).catch(() => null);
        if (!channel?.messages?.fetch) continue;
        const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
        if (!message?.edit || !message.components?.length) continue;
        if (message.author?.id && client.user?.id && message.author.id !== client.user.id) continue;
        let changed = false;
        const rows = message.components.flatMap(row => {
          const data = row.toJSON?.() || row;
          const kept = (data.components || []).filter(component => {
            const item = component.toJSON?.() || component;
            if (item.custom_id !== 'giveaway_manage') return true;
            changed = true;
            return false;
          });
          return kept.length ? [{ ...data, components: kept }] : [];
        });
        if (!changed) continue;
        await message.edit({ components: rows });
        totals.changed++;
      } catch (error) {
        totals.failed++;
        logger.warn('Could not remove old Manage button from giveaway ' + giveaway.messageId, error);
      }
    }
  }
  logger.info('One-time giveaway Manage button migration: ' + JSON.stringify(totals));
  return totals;
}
