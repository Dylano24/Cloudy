import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ChannelDelete,
  once: false,
  async execute(channel) {
    if (!channel.guild) return;
    try {
      await processAntiNukeAuditEvent(channel.guild, {
        auditType: AuditLogEvent.ChannelDelete,
        actionType: 'channel-delete',
        targetId: channel.id,
        targetLabel: `#${channel.name}`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke channel-delete monitor failed: ${error?.message || error}`);
    }
  },
};
