import { Events, AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    const { guild, user } = ban;

    try {
      await new Promise(resolve => setTimeout(resolve, 750));

      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 6,
      });
      const now = Date.now();
      const banEntry = auditLogs.entries.find(entry =>
        entry.target?.id === user.id &&
        now - entry.createdTimestamp < 15_000
      );
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