import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import { registerCloudyEmbedMessages } from '../services/embedRegistryService.js';

const PAGE_DELAY_MS = 200;
const CHANNEL_DELAY_MS = 350;
const BRANDING_SCAN_VERSION = 2;
const BRANDING_SCAN_STATE_KEY = 'global:cloudy:branding-history-scan-version';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function mapWithConcurrency(items, mapper, concurrency = 4) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function normalizeChannel(channel, botUserId) {
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return { scanned: 0, updated: 0 };

  let scanned = 0;
  let updated = 0;
  let before;

  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    }).catch(() => null);

    if (!messages?.size) break;

    const registrableMessages = [];
    for (const message of messages.values()) {
      scanned += 1;
      if (message.author?.id !== botUserId) continue;
      if (!message.embeds?.length) continue;

      if (await normalizeCloudyMessage(message, { ensureFooter: true })) updated += 1;
      registrableMessages.push(message);
    }

    if (registrableMessages.length) {
      await registerCloudyEmbedMessages(registrableMessages, 'history');
    }

    before = messages.last()?.id;
    if (messages.size < 100 || !before) break;
    await wait(PAGE_DELAY_MS);
  }

  return { scanned, updated };
}

export async function normalizeGuild(client, guild) {
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return { scanned: 0, updated: 0, completed: false };

  const channelList = [...channels.values()].filter(channel => channel?.isTextBased?.() && channel.messages?.fetch);
  const results = await mapWithConcurrency(channelList, async channel => normalizeChannel(channel, client.user.id), 4);

  const scanned = results.reduce((total, result) => total + (result?.scanned || 0), 0);
  const updated = results.reduce((total, result) => total + (result?.updated || 0), 0);

  console.log(`[CLOUDY_BRANDING] ${guild.name}: scanned ${scanned} messages, updated ${updated} bot messages.`);
  return { scanned, updated, completed: true };
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        const completedVersion = Number(
          await client.db?.get?.(BRANDING_SCAN_STATE_KEY, 0).catch(() => 0) || 0,
        );

        if (completedVersion >= BRANDING_SCAN_VERSION) {
          console.log('[CLOUDY_BRANDING] Full history scan already completed; live message normalization remains active.');
          return;
        }

        let allGuildsCompleted = true;

        for (const guild of client.guilds.cache.values()) {
          const result = await normalizeGuild(client, guild);
          if (!result.completed) allGuildsCompleted = false;
        }

        if (allGuildsCompleted) {
          await client.db?.set?.(BRANDING_SCAN_STATE_KEY, BRANDING_SCAN_VERSION).catch(() => null);
        }
      })().catch(error => {
        console.error('[CLOUDY_BRANDING] Existing-message normalization failed:', error);
      });
    }, 15_000);

    timer.unref?.();
  },
};
