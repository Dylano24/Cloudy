import { Events } from 'discord.js';
import { enforceJoinGate } from '../services/securityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    try {
      await enforceJoinGate(member);
    } catch (error) {
      logger.warn(`Join Gate failed for ${member.user?.tag || member.id}: ${error?.message || error}`);
    }
  },
};
