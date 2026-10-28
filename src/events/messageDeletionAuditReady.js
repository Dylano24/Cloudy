import { Events, PermissionFlagsBits } from 'discord.js';
import { primeDeletionAuditBaseline } from '../services/deletionAttributionService.js';
import { logger } from '../utils/logger.js';

// Reads each guild's current message-delete audit counts once at startup.
// Without that baseline a deletion right after a restart could not be told
// apart from an older one, and would be logged as "Unknown".
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    let primed = 0;
    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.me?.permissions?.has?.(PermissionFlagsBits.ViewAuditLog)) continue;
      if (await primeDeletionAuditBaseline(guild)) primed += 1;
    }
    logger.info(`Message deletion attribution baseline ready for ${primed} guild(s).`);
  },
};
