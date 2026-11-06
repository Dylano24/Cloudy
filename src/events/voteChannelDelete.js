import { Events } from 'discord.js';
import { forgetDeletedVotes } from '../services/voteService.js';
import { logger } from '../utils/logger.js';

// Votes in a deleted channel are forgotten at once (owner's choice).
export default {
  name: Events.ChannelDelete,
  once: false,
  async execute(channel, client) {
    const guildId = channel?.guildId || channel?.guild?.id;
    const activeClient = client || channel?.client;
    if (!activeClient || !guildId || !channel?.id) return;
    await forgetDeletedVotes(activeClient, guildId, { channelId: channel.id })
      .catch(error => logger.warn('Could not forget votes removed with channel ' + channel.id, error));
  },
};
