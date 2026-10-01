import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute() {
    logger.info('[CLOUDY_RESTORE] Automatic structure creation is disabled; the Sep 18 layout is preserved exactly.');
  },
};
