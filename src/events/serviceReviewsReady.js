import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import {
  SERVICE_REVIEWS_CHANNEL_ID, SERVICE_REVIEW_PANEL_MESSAGE_ID,
  SERVICE_REVIEW_PANEL_TITLE, SERVICE_REVIEW_SELECT_ID,
  serviceReviewChoiceRow,
} from '../services/serviceReviewsService.js';

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
  const hasChoice = components.some(row => (row.components || [])
    .some(item => item.custom_id === SERVICE_REVIEW_SELECT_ID));
  if (hasChoice) return { ok: true, action: 'preserved', id: message.id };
  if (components.length >= 5) return { ok: false, reason: 'components-full' };
  await message.edit({ components: [...components, serviceReviewChoiceRow()] });
  return { ok: true, action: 'updated', id: message.id };
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
    }, 2500);
    timer.unref?.();
  },
};
