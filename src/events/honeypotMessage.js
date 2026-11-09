import { Events } from 'discord.js';
import { handleHoneypotMessage } from '../services/honeypotService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message) {
    if (!message.inGuild?.()) return;
    try {
      await handleHoneypotMessage(message);
    } catch (error) {
      logger.warn('[HONEYPOT] Honeypot check failed:', error);
    }
  },
};
