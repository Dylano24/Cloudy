import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,
  async execute(member) {
    try {
      await processAntiNukeAuditEvent(member.guild, {
        auditType: AuditLogEvent.MemberKick,
        actionType: 'kick',
        targetId: member.id,
        targetLabel: `${member.user?.tag || member.id} (${member.id})`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke kick monitor failed: ${error?.message || error}`);
    }
  },
};
