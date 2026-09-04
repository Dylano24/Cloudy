import { Events } from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_RATING_ID,
  buildStaffReviewsPanel,
  getOwnerMembers,
} from '../services/staffReviewsService.js';

const PANEL_REFRESH_MS = 5 * 60 * 1000;
const POSTED_REVIEWS_CHANNEL_NAME = '★⠀│posted-reviews';

async function syncPostedReviewsChannelName(client) {
  const channel = await client.channels.fetch(COMMUNITY_REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.setName || channel.name === POSTED_REVIEWS_CHANNEL_NAME) return;

  await channel.setName(
    POSTED_REVIEWS_CHANNEL_NAME,
    'Use the white staff-review star in the channel name',
  ).catch(() => {});
}

/** Return whether a bot message is the persistent staff-review panel. */
function isStaffReviewsPanel(message, client) {
  return Boolean(
    message?.author?.id === client.user?.id
    && message.components?.some(row => row.components?.some(component =>
      component.customId === STAFF_REVIEW_MEMBER_ID
      || component.customId === STAFF_REVIEW_RATING_ID
      || component.customId?.startsWith(`${STAFF_REVIEW_RATING_ID}:`),
    )),
  );
}

/** Find the durable pinned panel, migrating a recent legacy panel if needed. */
async function findStaffReviewsPanel(channel, client) {
  const pins = await channel.messages.fetchPins().catch(() => null);
  if (!pins) return { lookupSucceeded: false, message: null };

  const pinnedPanel = pins.items
    .map(pin => pin.message)
    .find(message => isStaffReviewsPanel(message, client));
  if (pinnedPanel) return { lookupSucceeded: true, message: pinnedPanel };

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return { lookupSucceeded: false, message: null };

  return {
    lookupSucceeded: true,
    message: recent.find(message => isStaffReviewsPanel(message, client)) || null,
  };
}

/** Refresh the staff-review panel from the guild's current Owner membership. */
async function refreshStaffReviewsPanel(client) {
  const channel = await client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.isSendable?.()) return;

  const ownerMembers = await getOwnerMembers(channel.guild);
  const lookup = await findStaffReviewsPanel(channel, client);
  if (!lookup.lookupSucceeded) return;

  const payload = buildStaffReviewsPanel(ownerMembers);
  if (lookup.message) {
    await lookup.message.edit(payload).catch(() => {});
    if (!lookup.message.pinned) {
      await channel.messages.pin(lookup.message, 'Cloudy staff reviews panel').catch(() => {});
    }
    return;
  }

  const sent = await channel.send(payload).catch(() => null);
  if (sent) {
    await channel.messages.pin(sent, 'Cloudy staff reviews panel').catch(() => {});
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  /** Build the panel after startup and refresh it as Owner membership changes. */
  async execute(client) {
    await syncPostedReviewsChannelName(client);

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
