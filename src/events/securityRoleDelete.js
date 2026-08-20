import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildRoleDelete,
  once: false,
  async execute(role) {
    try {
      await processAntiNukeAuditEvent(role.guild, {
        auditType: AuditLogEvent.RoleDelete,
        actionType: 'role-delete',
        targetId: role.id,
        targetLabel: `@${role.name}`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke role-delete monitor failed: ${error?.message || error}`);
    }
  },
};
