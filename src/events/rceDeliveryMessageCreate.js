import { Events } from 'discord.js';
import { getRceRuntime } from '../services/rce/rceRuntime.js';
import { logger } from '../utils/logger.js';

// Store delivery lines ([KAOS]/[CLOUDY] ...) in the Rust delivery channel.
export default {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message?.guildId || !/\[(?:KAOS|CLOUDY)\]/i.test(`${message.content || ''}${(message.embeds || []).map(embed => embed.description || '').join('')}`)) return;
    try {
      await getRceRuntime()?.deliveries?.handleMessage(message);
    } catch (error) {
      logger.warn('[RCE] Store delivery message failed:', error?.message || error);
    }
  },
};
