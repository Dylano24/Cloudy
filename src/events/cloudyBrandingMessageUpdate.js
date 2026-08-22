import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    if (!newMessage?.client?.user?.id) return;

    const message = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;

    if (!message) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!message.embeds?.length) return;

    const timer = setTimeout(() => {
      void normalizeCloudyMessage(message, { ensureFooter: true });
    }, 250);

    timer.unref?.();
  },
};
