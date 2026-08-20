import { AuditLogEvent, Events } from 'discord.js';
import { processAntiNukeAuditEvent } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ChannelCreate,
  once: false,
  async execute(channel) {
    if (!channel.guild) return;
    try {
      await processAntiNukeAuditEvent(channel.guild, {
        auditType: AuditLogEvent.ChannelCreate,
        actionType: 'channel-create',
        targetId: channel.id,
        targetLabel: `#${channel.name}`,
      });
    } catch (error) {
      logger.warn(`Anti-nuke channel-create monitor failed: ${error?.message || error}`);
    }
  },
};
