import { Events } from 'discord.js';
import { startGameServerBoards } from '../services/gameServerBoardsService.js';
import { ensureFeedEmojis } from '../services/feedEmojiService.js';
import { ensureReportGuildDots } from '../services/reportGuildDotsService.js';

// Marks a game server offline on its boards when it stops reporting.
export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startGameServerBoards(client);
    void ensureFeedEmojis(client);
    void ensureReportGuildDots(client);
  },
};
