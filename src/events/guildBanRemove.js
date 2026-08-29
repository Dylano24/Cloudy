import { Events, AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { fetchRecentAuditEntry } from '../services/recentAuditLogService.js';

export default {
  name: Events.GuildBanRemove,
  once: false,

  async execute(ban) {
    const { guild, user } = ban;

    try {
      const unbanEntry = await fetchRecentAuditEntry(guild, AuditLogEvent.MemberBanRemove, user.id);
      const executor = unbanEntry?.executor;
      const reason = unbanEntry?.reason || 'No reason provided';

      await logEvent({
        client: guild.client,
        guildId: guild.id,
        eventType: EVENT_TYPES.MODERATION_UNBAN,
        data: {
          title: 'Unban log',
          color: 0x2ECC71,
          lines: [
            `**User:** ${user.toString()} (${user.tag})`,
            `**Unbanned by:** ${executor ? `${executor.toString()} (${executor.tag})` : 'Unknown'}`,
            `**Reason:** ${reason}`,
            `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`,
          ],
          quoted: false,
          thumbnail: user.displayAvatarURL({ size: 256 }),
          userId: user.id,
        },
      });
    } catch (error) {
      logger.warn('Could not create unban log:', error.message);
    }
  },
};
