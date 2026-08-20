import { Events, AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanRemove,
  once: false,

  async execute(ban) {
    const { guild, user } = ban;

    try {
      await new Promise(resolve => setTimeout(resolve, 750));

      const suppressionKey = `${guild.id}:${user.id}`;
      const attribution = guild.client.commandUnbanLogSuppressions?.get(suppressionKey);
      const hasCommandAttribution = Boolean(
        attribution &&
        typeof attribution === 'object' &&
        attribution.expiresAt > Date.now()
      );

      const auditLogs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanRemove,
        limit: 6,
      });
      const now = Date.now();
      const unbanEntry = auditLogs.entries.find(entry =>
        entry.target?.id === user.id &&
        now - entry.createdTimestamp < 15_000
      );

      const auditExecutor = unbanEntry?.executor;
      const reason = hasCommandAttribution
        ? attribution.reason
        : (unbanEntry?.reason || 'No reason provided');

      let unbannedBy = 'Automod';
      if (hasCommandAttribution) {
        unbannedBy = `${attribution.moderatorMention} (${attribution.moderatorTag})`;
        guild.client.commandUnbanLogSuppressions?.delete(suppressionKey);
      } else if (auditExecutor && !auditExecutor.bot) {
        unbannedBy = `${auditExecutor.toString()} (${auditExecutor.tag})`;
      }

      await logEvent({
        client: guild.client,
        guildId: guild.id,
        eventType: EVENT_TYPES.MODERATION_UNBAN,
        data: {
          title: 'Unban log',
          color: 0x2ECC71,
          lines: [
            `**User:** ${user.toString()} (${user.tag})`,
            `**Unbanned by:** ${unbannedBy}`,
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
