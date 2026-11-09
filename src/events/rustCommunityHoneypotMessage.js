import { Events } from 'discord.js';
import { handleRustHoneypotMessage } from '../services/rustCommunityExtrasService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message) {
    if (!message.inGuild?.()) return;
    try {
      await handleRustHoneypotMessage(message);
    } catch (error) {
      logger.warn('[RUST_COMMUNITY] Honeypot check failed:', error);
    }
  },
};
