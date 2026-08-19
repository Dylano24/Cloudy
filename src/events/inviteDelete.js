import { Events } from 'discord.js';
import { recordInviteDeleted } from '../services/inviteTrackingService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.InviteDelete,
  once: false,

  async execute(invite) {
    try {
      await recordInviteDeleted(invite);
    } catch (error) {
      logger.error('InviteDelete cache update failed:', error);
    }
  },
};
