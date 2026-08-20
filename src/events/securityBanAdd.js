import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,
  async execute(ban) {
    try {
      await processAntiNukeAuditEvent(ban.guild, {
        auditType: AuditLogEvent.MemberBanAdd,
        actionType: 'ban',
        targetId: ban.user.id,
        targetLabel: `${ban.user.tag} (${ban.user.id})`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke ban monitor failed: ${error?.message || error}`);
    }
  },
};
