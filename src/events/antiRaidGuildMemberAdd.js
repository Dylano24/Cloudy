import { Events } from 'discord.js';
import { enforceJoinRaidProtection } from '../services/automodProtectionService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      await enforceJoinRaidProtection(member);
    } catch (error) {
      logger.error('Error in join raid protection:', error);
    }
  },
};
