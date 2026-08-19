import { Events } from 'discord.js';
import { recordInviteCreated } from '../services/inviteTrackingService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.InviteCreate,
  once: false,

  async execute(invite) {
    try {
      await recordInviteCreated(invite);
    } catch (error) {
      logger.error('InviteCreate logging failed:', error);
    }
  },
};
