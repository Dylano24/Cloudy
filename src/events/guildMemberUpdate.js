import { Events, AuditLogEvent } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { enforceProtectedIdentityProfile } from '../services/protectedIdentityService.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;

      if (await enforceProtectedIdentityProfile(newMember)) {
        return;
      }

      const oldTimeout = oldMember.communicationDisabledUntilTimestamp || 0;
      const newTimeout = newMember.communicationDisabledUntilTimestamp || 0;

      if (newTimeout > Date.now() && newTimeout !== oldTimeout) {
        try {
          await new Promise(resolve => setTimeout(resolve, 750));
          const auditLogs = await newMember.guild.fetchAuditLogs({
            type: AuditLogEvent.MemberUpdate,
            limit: 6,
          });
          const now = Date.now();
          const timeoutEntry = auditLogs.entries.find(entry =>
            entry.target?.id === newMember.id &&
            now - entry.createdTimestamp < 15_000
          );
          const executor = timeoutEntry?.executor;
          const reason = timeoutEntry?.reason || 'No reason provided';
          const durationMs = Math.max(0, newTimeout - Date.now());
          const durationMinutes = Math.max(1, Math.ceil(durationMs / 60_000));

          await logEvent({
            client: newMember.client,
            guildId: newMember.guild.id,
            eventType: EVENT_TYPES.MODERATION_TIMEOUT,
            data: {
              title: 'Timeout log',
              lines: [
                `**User:** ${newMember.user.toString()} (${newMember.user.tag})`,
                `**Timed-out by:** ${executor ? `${executor.toString()} (${executor.tag})` : 'Unknown'}`,
                `**Reason:** ${reason}`,
                `**Duration:** ${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`,
                `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`,
              ],
              quoted: false,
              thumbnail: newMember.user.displayAvatarURL({ size: 256 }),
              userId: newMember.id,
            },
          });
        } catch (auditError) {
          logger.warn('Could not inspect audit logs for a member timeout:', auditError.message);
        }
      }

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            title: 'Nickname changed',
            lines: [
              `**Before:** ${oldMember.nickname || '*(no nickname)*'}`,
              `**After:** ${newMember.nickname || '*(no nickname)*'}`,
            ],
            thumbnail: newMember.user.displayAvatarURL({ dynamic: true }),
            userId: newMember.user.id,
          }
        });

        return;
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  }
};
