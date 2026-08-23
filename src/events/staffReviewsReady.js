import { Events } from 'discord.js';
import {
  STAFF_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_RATING_ID,
  buildStaffReviewsPanel,
  getOwnerMembers,
} from '../services/staffReviewsService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const channel = await client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
      if (!channel?.isSendable?.()) return;

      const ownerMembers = await getOwnerMembers(channel.guild);
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const existing = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.components?.some(row => row.components?.some(component =>
          component.customId === STAFF_REVIEW_MEMBER_ID
          || component.customId === STAFF_REVIEW_RATING_ID,
        )),
      );

      const payload = buildStaffReviewsPanel(ownerMembers);
      if (existing) {
        await existing.edit(payload).catch(() => {});
      } else {
        await channel.send(payload).catch(() => {});
      }
    }, 2500);

    timer.unref?.();
  },
};
