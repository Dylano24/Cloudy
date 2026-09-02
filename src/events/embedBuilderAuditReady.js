import { Events } from 'discord.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { buildEmbedPayload } from '../services/embedManagerService.js';
import { discoverRecentChannelEmbeds } from '../services/embedMissingChannelService.js';
import { logger } from '../utils/logger.js';

const TARGET_ID = '1532882647838228723';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function channelByName(guild, matcher) {
  return [...guild.channels.cache.values()].find(channel => matcher.test(clean(channel.name))) || null;
}

function payloadOptions(payload) {
  for (const row of payload?.components || []) {
    const data = row.toJSON?.() || row;
    const select = data?.components?.find(component => component.type === 3);
    if (select?.options) return select.options.map(option => String(option.label || ''));
  }
  return [];
}

function allRenderedLabels(guild, records, channelId) {
  const labels = [];
  const signatures = new Set();
  for (let page = 0; page < 20; page += 1) {
    const options = payloadOptions(buildEmbedPayload(guild, records, channelId, page));
    const signature = options.join('\u0000');
    if (signatures.has(signature)) break;
    signatures.add(signature);
    labels.push(...options);
    if (options.length < 25) break;
  }
  return labels;
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      try {
        const guild = client.guilds.cache.get(TARGET_ID) || null;
        if (!guild) {
          logger.warn(`[EMBED_BUILDER_VERIFY] target guild ${TARGET_ID} not found`);
          return;
        }

        const records = await getEmbedRegistry(guild.id);
        const ticketLogs = channelByName(guild, /ticket[-│|\s]*logs?/i);
        if (ticketLogs) {
          const labels = allRenderedLabels(guild, records, ticketLogs.id);
          const forbidden = labels.filter(label => /contact the staff|change panel|system debug|system health|panel set up|diagnostic failed|terms of service|remove task|dashboard/i.test(label));
          logger.warn(`[EMBED_BUILDER_VERIFY] TICKET_UI channel=${ticketLogs.id}:${clean(ticketLogs.name)} count=${labels.length} labels=${JSON.stringify(labels)} forbidden=${JSON.stringify(forbidden)}`);
        } else {
          logger.warn('[EMBED_BUILDER_VERIFY] TICKET_UI channel not found');
        }

        const faq = channelByName(guild, /faq/i);
        if (faq) {
          const recent = await discoverRecentChannelEmbeds(guild, faq.id, client.user.id).catch(() => []);
          const combined = [
            ...records.filter(record => String(record.channelId) !== String(faq.id)),
            ...records.filter(record => String(record.channelId) === String(faq.id) && String(record.source || '') === 'system-catalog'),
            ...recent,
          ];
          const labels = allRenderedLabels(guild, combined, faq.id);
          const assistants = labels.filter(label => /cloudy.*assistant/i.test(label));
          const recentAssistants = recent.filter(record => /cloudy.*assistant/i.test(clean(record.snapshot?.title || record.title || record.name))).map(record => clean(record.snapshot?.title || record.title || record.name));
          logger.warn(`[EMBED_BUILDER_VERIFY] ASSISTANT_UI channel=${faq.id}:${clean(faq.name)} rendered=${JSON.stringify(assistants)} recentRaw=${JSON.stringify(recentAssistants)}`);
        } else {
          logger.warn('[EMBED_BUILDER_VERIFY] ASSISTANT_UI faq channel not found');
        }
      } catch (error) {
        logger.error(`[EMBED_BUILDER_VERIFY] failed: ${error?.stack || error}`);
      }
    }, 9000);
    timer.unref?.();
  },
};
