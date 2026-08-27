import { Events } from 'discord.js';
import { enforceAutomodProtection } from '../services/automodProtectionService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    try {
      await enforceAutomodProtection(message);
    } catch (error) {
      logger.error('Error in anti-abuse message protection:', error);
    }
  },
};
