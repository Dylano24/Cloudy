import { Events } from 'discord.js';
import { startVoteTimer } from '../services/voteService.js';

// Closes /vote votes when their end time passes (checked every minute).
export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startVoteTimer(client);
  },
};
