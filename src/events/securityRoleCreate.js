import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildRoleCreate,
  once: false,
  async execute(role) {
    try {
      await processAntiNukeAuditEvent(role.guild, {
        auditType: AuditLogEvent.RoleCreate,
        actionType: 'role-create',
        targetId: role.id,
        targetLabel: `@${role.name}`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke role-create monitor failed: ${error?.message || error}`);
    }
  },
};
