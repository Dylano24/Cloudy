import { Events } from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_RATING_ID,
  buildStaffReviewsPanel,
  staffReviewPanelRows,
  getOwnerMembers,
} from '../services/staffReviewsService.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { logger } from '../utils/logger.js';
import { createSingleFlight } from '../utils/singleFlight.js';

const PANEL_REFRESH_MS = 5 * 60 * 1000;

/** Return whether a bot message is the persistent staff-review panel. */
function isStaffReviewsPanel(message, client) {
  return Boolean(
    message?.author?.id === client.user?.id
    && message.components?.some(row => row.components?.some(component => {
      const id = component.customId || component.custom_id || component.toJSON?.().custom_id;
      return id === STAFF_REVIEW_MEMBER_ID || id === STAFF_REVIEW_RATING_ID
        || id?.startsWith(`${STAFF_REVIEW_RATING_ID}:`);
    })),
  );
}

/** Find the durable pinned panel, migrating a recent legacy panel if needed. */
async function findStaffReviewsPanel(channel, client) {
  const pins = await channel.messages.fetchPins?.().catch(() => null);
  const pinnedPanel = pins?.items?.map(pin => pin.message)
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
  const channel = await resolveCloudyChannel(client, 'staffReviews', { textOnly: true });
  if (!channel?.isSendable?.()) return;

  const ownerMembers = await getOwnerMembers(channel.guild);
  const postedReviewsChannel = await resolveCloudyChannel(client, 'postedReviews', { guild: channel.guild, textOnly: true });
  const lookup = await findStaffReviewsPanel(channel, client);
  if (!lookup.lookupSucceeded) return;

  const payload = buildStaffReviewsPanel(ownerMembers, postedReviewsChannel?.id || COMMUNITY_REVIEWS_CHANNEL_ID);
  if (lookup.message) {
    // Owner membership changes only require fresh selectors. Never rebuild the
    // existing embed here: Embed Builder owns its saved text, custom emojis,
    // color, footer and other presentation.
    const migratedEmbeds = lookup.message.embeds.map(embed => {
      const data = embed.toJSON();
      if (postedReviewsChannel?.id && data.description?.includes(COMMUNITY_REVIEWS_CHANNEL_ID)) {
        data.description = data.description.replaceAll(COMMUNITY_REVIEWS_CHANNEL_ID, postedReviewsChannel.id);
      }
      return data;
    });
    // Do not redraw the public menus every five minutes. That would erase
    // each reviewer's local selection, even when nothing actually changed.
    const oldRows = lookup.message.components.map(row => row.toJSON?.() || row);
    const newRows = payload.components.map(row => row.toJSON?.() || row);
    // Preserve the rotated rating ID between scheduled refreshes. Otherwise
    // the five-minute refresh needlessly redraws a member's active selection.
    const oldRating = oldRows.flatMap(row => row.components || [])
      .find(component => String(component.custom_id || '').startsWith(`${STAFF_REVIEW_RATING_ID}:reset:`));
    const newRating = newRows.flatMap(row => row.components || [])
      .find(component => component.custom_id === STAFF_REVIEW_RATING_ID);
    if (oldRating && newRating) newRating.custom_id = oldRating.custom_id;
    // Keep the same explicit unselected defaults that the post-reset rows use.
    // Otherwise a five-minute refresh can redraw a still-active review for no reason.
    for (const row of newRows) {
      for (const component of row.components || []) {
        if (component.custom_id === STAFF_REVIEW_MEMBER_ID
          || String(component.custom_id || '').startsWith(STAFF_REVIEW_RATING_ID)) {
          component.options = (component.options || []).map(option => ({ ...option, default: false }));
        }
      }
    }
    const oldEmbeds = lookup.message.embeds.map(embed => embed.toJSON?.() || embed);
    if (JSON.stringify(oldRows) !== JSON.stringify(newRows)
      || JSON.stringify(oldEmbeds) !== JSON.stringify(migratedEmbeds)) {
      await lookup.message.edit({ embeds: migratedEmbeds, components: payload.components }).catch(() => {});
    }
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

// Restore the same owner-authored panel after a review is successfully
// published. Never repost or modify its embed, title, footer, or logo.
export async function resetStaffReviewPanel(client, { guild = null } = {}) {
  const channel = await resolveCloudyChannel(client, 'staffReviews', { guild, textOnly: true });
  if (!channel?.messages) return false;
  const lookup = await findStaffReviewsPanel(channel, client);
  const message = lookup.message;
  if (!message) return false;
  const components = staffReviewPanelRows(message, { ratingEnabled: true });
  if (!components) return false;
  // A fresh custom ID makes Discord forget the previous user's locally
  // selected stars. The visible controls and their default values stay the same.
  const rating = components.flatMap(row => row.components || [])
    .find(component => component.custom_id === STAFF_REVIEW_RATING_ID);
  if (!rating) return false;
  rating.custom_id = `${STAFF_REVIEW_RATING_ID}:reset:${randomUUID()}`;
  await message.edit({ components });
  return true;
}

export default {
  name: Events.ClientReady,
  once: true,

  /** Build the panel after startup and refresh it as Owner membership changes. */
  async execute(client) {
    const refresh = createSingleFlight(async () => {
      try {
        await refreshStaffReviewsPanel(client);
      } catch (error) {
        logger.warn(`Staff reviews panel refresh failed: ${error.message}`);
      }
    });
    const timer = setTimeout(async () => {
      await refresh();

      const refreshInterval = setInterval(() => {
        void refresh();
      }, PANEL_REFRESH_MS);
      refreshInterval.unref?.();
    }, 2500);

    timer.unref?.();
  },
};
