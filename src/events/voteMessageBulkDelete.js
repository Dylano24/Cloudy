import { Events } from 'discord.js';
import { forgetDeletedVotes } from '../services/voteService.js';
import { logger } from '../utils/logger.js';

// Vote messages removed in a purge are forgotten at once (owner's choice).
export default {
  name: Events.MessageBulkDelete,
  once: false,
  async execute(messages) {
    const list = [...(messages?.values?.() || [])];
    const first = list.find(message => message?.client && (message.guildId || message.guild?.id));
    if (!first) return;
    const client = first.client;
    const guildId = first.guildId || first.guild.id;
    const messageIds = list.filter(message =>
      (message.guildId || message.guild?.id) === guildId
      && (!message.author?.id || !client.user?.id || message.author.id === client.user.id))
      .map(message => message.id);
    if (!messageIds.length) return;
    await forgetDeletedVotes(client, guildId, { messageIds })
      .catch(error => logger.warn('Could not forget bulk-deleted vote messages in ' + guildId, error));
  },
};
