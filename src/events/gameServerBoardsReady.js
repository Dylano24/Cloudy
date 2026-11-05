import { Events } from 'discord.js';
import { startGameServerBoards } from '../services/gameServerBoardsService.js';

// Marks a game server offline on its boards when it stops reporting.
export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startGameServerBoards(client);
  },
};
