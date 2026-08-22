import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.client?.user?.id) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!message.embeds?.length) return;

    const timer = setTimeout(() => {
      void normalizeCloudyMessage(message, { ensureFooter: true });
    }, 500);

    timer.unref?.();
  },
};
