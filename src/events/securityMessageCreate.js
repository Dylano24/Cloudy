import { Events } from 'discord.js';
import { enforceAntiSpam } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message) {
    try {
      await enforceAntiSpam(message);
    } catch (error) {
      logger.warn(`Security anti-spam failed in ${message.guild?.id || 'DM'}: ${error?.message || error}`);
    }
  },
};
