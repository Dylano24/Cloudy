import { Events } from 'discord.js';
import { forgetDeletedVotes } from '../services/voteService.js';
import { logger } from '../utils/logger.js';

// A vote message deleted in Discord is forgotten at once (owner's choice):
// /votemanage then no longer lists it as Active or Ended.
export default {
  name: Events.MessageDelete,
  once: false,
  async execute(message) {
    const client = message?.client;
    const guildId = message?.guildId || message?.guild?.id;
    if (!client || !guildId || !message?.id) return;
    if (message.author?.id && client.user?.id && message.author.id !== client.user.id) return;
    await forgetDeletedVotes(client, guildId, { messageIds: [message.id] })
      .catch(error => logger.warn('Could not forget deleted vote message ' + message.id, error));
  },
};
