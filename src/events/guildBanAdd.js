import { Events, AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import { fetchRecentAuditEntry } from '../services/recentAuditLogService.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    const { guild, user } = ban;

    try {
      const banEntry = await fetchRecentAuditEntry(guild, AuditLogEvent.MemberBanAdd, user.id);
      const executor = banEntry?.executor;
      const reason = banEntry?.reason || 'No reason provided';

      // The protected identity system already sends its own detailed ban embed.
      if (
        executor?.id === guild.client.user?.id &&
        reason.startsWith('Automatic ban: blocked identity detected')
      ) {
        return;
      }

      await logEvent({
        client: guild.client,
        guildId: guild.id,
        eventType: EVENT_TYPES.MODERATION_BAN,
        data: {
          title: 'Ban log',
          color: getColor('red'),
          lines: [
            `**User:** ${user.toString()} (${user.tag})`,
            `**Banned by:** ${executor ? `${executor.toString()} (${executor.tag})` : 'Unknown'}`,
            `**Reason:** ${reason}`,
            `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`,
          ],
          quoted: false,
          thumbnail: user.displayAvatarURL({ size: 256 }),
          userId: user.id,
        },
      });
    } catch (error) {
      logger.warn('Could not create ban log:', error.message);
    }
  },
};
