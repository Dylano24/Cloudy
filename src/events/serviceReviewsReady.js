import { Events } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import {
  SERVICE_REVIEWS_CHANNEL_ID, SERVICE_REVIEW_PANEL_MESSAGE_ID,
  SERVICE_REVIEW_SELECT_ID, SERVICE_REVIEW_RATING_ID,
  SERVICE_REVIEW_PANEL_TITLE, SERVICE_POSTED_REVIEWS_CHANNEL_ID,
  serviceReviewPanelRows, normalizeLegacyServiceReviewEmbed,
} from '../services/serviceReviewsService.js';

// Rotate both menu IDs only AFTER a review was published. Their labels,
 // choices, and the owner-written embed are unchanged; new IDs force Discord
// to discard locally selected values from the completed review.
export async function resetServiceReviewsPanel(client, { guild = null } = {}) {
  const channel = await resolveCloudyChannel(client, 'serviceReviews', { guild, textOnly: true });
  if (!channel || channel.id !== SERVICE_REVIEWS_CHANNEL_ID) return false;
  let message = await channel.messages.fetch(SERVICE_REVIEW_PANEL_MESSAGE_ID).catch(() => null);
  const isPanel = candidate => candidate?.author?.id === client.user?.id
    && candidate.embeds?.some(embed => embed.title === SERVICE_REVIEW_PANEL_TITLE);
  if (!isPanel(message)) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    message = recent?.find(isPanel) || null;
  }
  if (!message) return false;
  const components = serviceReviewPanelRows().map(row => row.toJSON());
  const revision = randomUUID();
  components[0].components[0].custom_id = `${SERVICE_REVIEW_SELECT_ID}:reset:${revision}`;
  components[1].components[0].custom_id = `${SERVICE_REVIEW_RATING_ID}:reset:${revision}`;
  await message.edit({ components });
  return true;
}

export async function reconcileServiceReviewsPanel(client) {
  const guild = client.guilds?.cache?.get('1532882647838228723');
  if (!guild) return { ok: false, reason: 'guild-missing' };
  const channel = await resolveCloudyChannel(client, 'serviceReviews', { guild, textOnly: true });
  if (!channel || channel.id !== SERVICE_REVIEWS_CHANNEL_ID) return { ok: false, reason: 'channel-missing' };

  // Only add controls to the existing owner-authored embed. No replacement
  // description or auto-created copy is allowed.
  let message = await channel.messages.fetch(SERVICE_REVIEW_PANEL_MESSAGE_ID).catch(() => null);
  const isPanel = candidate => candidate?.author?.id === client.user?.id
    && candidate.embeds?.some(e => e.title === SERVICE_REVIEW_PANEL_TITLE);
  if (!isPanel(message)) {
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    message = recent?.find(isPanel) || null;
  }
  if (!message) return { ok: false, reason: 'panel-missing' };

  const components = message.components?.map(row => row.toJSON?.() || row) || [];
  const rows = serviceReviewPanelRows();
  const desired = rows.map(row => row.toJSON());
  // Update only the controls on the existing owner-written embed (never repost
  // the panel). On restart, reset an interrupted review to the idle state.
  if (JSON.stringify(components) === JSON.stringify(desired)) {
    return { ok: true, action: 'preserved', id: message.id };
  }
  await message.edit({ components: rows });
  return { ok: true, action: 'updated', id: message.id };
}

// Make already-posted reviews match the new layout, but only for legacy
// Service Reviews authored by this bot. Never repost or alter staff reviews.
export async function migrateLegacyServiceReviews(client) {
  const guild = client.guilds?.cache?.get('1532882647838228723');
  if (!guild) return { updated: 0, reason: 'guild-missing' };
  const channel = await resolveCloudyChannel(client, 'servicePostedReviews', { guild, textOnly: true });
  if (!channel || channel.id !== SERVICE_POSTED_REVIEWS_CHANNEL_ID) {
    return { updated: 0, reason: 'channel-missing' };
  }
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return { updated: 0, reason: 'messages-unavailable' };
  let updated = 0;
  for (const message of messages.values()) {
    if (message.author?.id !== client.user?.id || message.embeds?.length !== 1) continue;
    const normalized = normalizeLegacyServiceReviewEmbed(message.embeds[0]);
    if (!normalized) continue;
    try {
      await message.edit({ embeds: [normalized] });
      updated += 1;
    } catch (error) {
      logger.warn('[SERVICE_REVIEWS] Could not update existing review:', error);
    }
  }
  return { updated };
}

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const timer = setTimeout(() => {
      void reconcileServiceReviewsPanel(client)
        .then(result => {
          if (!result.ok) logger.warn('[SERVICE_REVIEWS] Panel unavailable:', result.reason);
        })
        .catch(error => logger.error('[SERVICE_REVIEWS] Panel reconciliation failed:', error));
      void migrateLegacyServiceReviews(client)
        .then(({ updated }) => {
          if (updated) logger.info(`[SERVICE_REVIEWS] Updated ${updated} existing reviews`);
        })
        .catch(error => logger.error('[SERVICE_REVIEWS] Legacy review migration failed:', error));
    }, 2500);
    timer.unref?.();
  },
};
