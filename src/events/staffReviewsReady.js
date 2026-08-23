import { Events } from 'discord.js';
import {
  STAFF_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_RATING_ID,
  buildStaffReviewsPanel,
  getOwnerMembers,
} from '../services/staffReviewsService.js';

const PANEL_REFRESH_MS = 5 * 60 * 1000;

/** Refresh the staff-review panel from the guild's current Owner membership. */
async function refreshStaffReviewsPanel(client) {
  const channel = await client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.isSendable?.()) return;

  const ownerMembers = await getOwnerMembers(channel.guild);
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!recent) return;

  const existing = recent.find(message =>
    message.author?.id === client.user?.id
    && message.components?.some(row => row.components?.some(component =>
      component.customId === STAFF_REVIEW_MEMBER_ID
      || component.customId === STAFF_REVIEW_RATING_ID
      || component.customId?.startsWith(`${STAFF_REVIEW_RATING_ID}:`),
    )),
  );

  const payload = buildStaffReviewsPanel(ownerMembers);
  if (existing) {
    await existing.edit(payload).catch(() => {});
  } else {
    await channel.send(payload).catch(() => {});
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  /** Build the panel after startup and refresh it as Owner membership changes. */
  async execute(client) {
    const timer = setTimeout(async () => {
      await refreshStaffReviewsPanel(client);

      const refreshInterval = setInterval(() => {
        void refreshStaffReviewsPanel(client);
      }, PANEL_REFRESH_MS);
      refreshInterval.unref?.();
    }, 2500);

    timer.unref?.();
  },
};
